

import _ = require('lodash');
import { meta } from '../meta';
import plugins from '../plugins';
import db from '../database';
import groups from '../groups';
import utils from '../utils';

interface User {
    status: string;
    lastonline: number;
    flags: string;
    search: SearchData;
    uid: number;
    getUsers(users: number[], user: number): UserData;
    getUsersFields(users: number[], fields);
}

interface UserData {
    users: User[];
    filter(user: User): User[];
}

interface SearchData {
    matchCount: number;
    pageCount: number;
    timing: string;
    users: User[];
    query: string;
    searchBy: string;
    page: number;
    uid: number;
    paginate;
    hardCap: number;
    findUids: number[];
    resultsPerPage: number;
    split(separator: string);
    filters: any[];
    sortBy: any;
    groupName: any;
    sortDirection: any;
}

export = function (User: User) {
    const filterFnMap = {
        online: (user: User) => user.status !== 'offline' && (Date.now() - user.lastonline < 300000),
        flagged: (user: User) => parseInt(user.flags, 10) > 0,
        verified: (user: User) => !!user['email:confirmed'],
        unverified: (user: User) => !user['email:confirmed'],
    };

    const filterFieldMap = {
        online: ['status', 'lastonline'],
        flagged: ['flags'],
        verified: ['email:confirmed'],
        unverified: ['email:confirmed'],
    };


    User.search = async function (data: SearchData) {
        const query = data.query || '';
        const searchBy = data.searchBy || 'username';
        const page = data.page || 1;
        const uid = data.uid || 0;
        const paginate = data.hasOwnProperty('paginate') ? data.paginate : true;

        const startTime = process.hrtime();

        let uids = [];
        if (searchBy === 'ip') {
            uids = await searchByIP(query);
        } else if (searchBy === 'uid') {
            uids = [query];
        } 
        // else {
        //     const searchMethod = data.findUids || findUids;
        //     uids = await searchMethod(query, searchBy, data.hardCap);
        // }

        uids = await filterAndSortUids(uids, data);
        const result = await plugins.hooks.fire('filter:users.search', { uids: uids, uid: uid });
        uids = result.uids;

        const searchResult: SearchData = {
            matchCount: uids.length,
            pageCount: 0,
            timing: '',
            users: uids,
            query: '',
            searchBy: '',
            page: 0,
            uid: 0,
            paginate: undefined,
            hardCap: 0,
            findUids: [],
            resultsPerPage: 0,
            split: function (separator: string) {
                throw new Error('Function not implemented.');
            },
            filters: [],
            sortBy: undefined,
            groupName: undefined,
            sortDirection: undefined
        };

        if (paginate) {
            const resultsPerPage = data.resultsPerPage || meta.config.userSearchResultsPerPage;
            const start = Math.max(0, page - 1) * resultsPerPage;
            const stop = start + resultsPerPage;
            searchResult.pageCount = Math.ceil(uids.length / resultsPerPage);
            uids = uids.slice(start, stop);
        }

        const userData: UserData = User.getUsers(uids, uid);
        searchResult.timing = (elapsedTimeSince(startTime) / 1000).toFixed(2);
        searchResult.users = userData.filter(User);
        return searchResult;
    };

    async function findUids(query: string, searchBy: any, hardCap: number) {
        if (!query) {
            return [];
        }
        query = String(query).toLowerCase();
        const min = query;
        const max = query.substr(0, query.length - 1) + String.fromCharCode(query.charCodeAt(query.length - 1) + 1);

        const resultsPerPage = meta.config.userSearchResultsPerPage;
        hardCap = hardCap || resultsPerPage * 10;

        const data = await db.getSortedSetRangeByLex(`${searchBy}:sorted`, min, max, 0, hardCap);
        const uids = data.map((data: SearchData) => data.split(':').pop());
        return uids;
    }

    async function filterAndSortUids(uids: any[], data: { filters: any[]; sortBy: any; groupName: any; sortDirection: any; }) {
        uids = uids.filter((uid: string) => parseInt(uid, 10));
        let filters = data.filters || [];
        filters = Array.isArray(filters) ? filters : [data.filters];
        const fields = [];

        if (data.sortBy) {
            fields.push(data.sortBy);
        }

        filters.forEach((filter: string | number) => {
            if (filterFieldMap[filter]) {
                fields.push(...filterFieldMap[filter]);
            }
        });

        if (data.groupName) {
            const isMembers = await groups.isMembers(uids, data.groupName);
            uids = uids.filter((uid: any, index: string | number) => isMembers[index]);
        }

        if (!fields.length) {
            return uids;
        }

        if (filters.includes('banned') || filters.includes('notbanned')) {
            const isMembersOfBanned = await groups.isMembers(uids, groups.BANNED_USERS);
            const checkBanned = filters.includes('banned');
            uids = uids.filter((uid: any, index: string | number) => (checkBanned ? isMembersOfBanned[index] : !isMembersOfBanned[index]));
        }

        fields.push('uid');
        let userData = await User.getUsersFields(uids, fields);

        filters.forEach((filter: string | number) => {
            if (filterFnMap[filter]) {
                userData = userData.filter(filterFnMap[filter]);
            }
        });

        if (data.sortBy) {
            sortUsers(userData, data.sortBy, data.sortDirection);
        }

        return userData.map((user: { uid: any; }) => user.uid);
    }

    function sortUsers(userData: User[], sortBy: string | number, sortDirection: string) {
        if (!userData || !userData.length) {
            return;
        }
        sortDirection = sortDirection || 'desc';
        const direction = sortDirection === 'desc' ? 1 : -1;

        const isNumeric = utils.isNumber(userData[0][sortBy]);
        if (isNumeric) {
            userData.sort((u1: User, u2: User) => direction * (u2[sortBy] - u1[sortBy]));
        } else {
            userData.sort((u1: User, u2: User) => {
                if (u1[sortBy] < u2[sortBy]) {
                    return direction * -1;
                } else if (u1[sortBy] > u2[sortBy]) {
                    return direction * 1;
                }
                return 0;
            });
        }
    }

    async function searchByIP(ip: any) {
        const ipKeys = await db.scan({ match: `ip:${ip}*` });
        const uids = await db.getSortedSetRevRange(ipKeys, 0, -1);
        return _.uniq(uids);
    }

    // From ChatGPT: a custom function to measure elapsed time
    function elapsedTimeSince(startTime: [number, number]): number {
        const elapsed = process.hrtime(startTime);
        return (elapsed[0] * 1000) + (elapsed[1] / 1e6);
    }
};
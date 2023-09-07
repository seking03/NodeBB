"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.myFunction = void 0;
const lodash_1 = __importDefault(require("lodash"));
const meta_1 = __importDefault(require("../meta"));
const plugins_1 = __importDefault(require("../plugins"));
const database_1 = __importDefault(require("../database"));
const groups_1 = __importDefault(require("../groups"));
const utils_1 = __importDefault(require("../utils"));
const myFunction = (User) => {
    const filterFnMap = {
        online: (user) => user.status !== 'offline' && (Date.now() - user.lastonline < 300000),
        flagged: (user) => parseInt(user.flags, 10) > 0,
        verified: (user) => !!user['email:confirmed'],
        unverified: (user) => !user['email:confirmed'],
    };
    const filterFieldMap = {
        online: ['status', 'lastonline'],
        flagged: ['flags'],
        verified: ['email:confirmed'],
        unverified: ['email:confirmed'],
    };
    User.search = function (data) {
        return __awaiter(this, void 0, void 0, function* () {
            const query = data.query || '';
            const searchBy = data.searchBy || 'username';
            const page = data.page || 1;
            const uid = data.uid || 0;
            const paginate = data.hasOwnProperty('paginate') ? data.paginate : true;
            const startTime = process.hrtime();
            let uids = [];
            if (searchBy === 'ip') {
                uids = yield searchByIP(query);
            }
            else if (searchBy === 'uid') {
                uids = [query];
            }
            else {
                const searchMethod = data.findUids || findUids;
                uids = yield searchMethod(query, searchBy, data.hardCap);
            }
            uids = yield filterAndSortUids(uids, data);
            const result = yield plugins_1.default.hooks.fire('filter:users.search', { uids: uids, uid: uid });
            uids = result.uids;
            const searchResult = {
                matchCount: uids.length,
            };
            if (paginate) {
                const resultsPerPage = data.resultsPerPage || meta_1.default.config.userSearchResultsPerPage;
                const start = Math.max(0, page - 1) * resultsPerPage;
                const stop = start + resultsPerPage;
                searchResult.pageCount = Math.ceil(uids.length / resultsPerPage);
                uids = uids.slice(start, stop);
            }
            const userData = yield User.getUsers(uids, uid);
            searchResult.timing = (ElapsedTimeSince(startTime) / 1000).toFixed(2);
            searchResult.users = userData.filter(user => user && user.uid > 0);
            return searchResult;
        });
    };
    function findUids(query, searchBy, hardCap) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!query) {
                return [];
            }
            query = String(query).toLowerCase();
            const min = query;
            const max = query.substr(0, query.length - 1) + String.fromCharCode(query.charCodeAt(query.length - 1) + 1);
            const resultsPerPage = meta_1.default.config.userSearchResultsPerPage;
            hardCap = hardCap || resultsPerPage * 10;
            const data = yield database_1.default.getSortedSetRangeByLex(`${searchBy}:sorted`, min, max, 0, hardCap);
            const uids = data.map(data => data.split(':').pop());
            return uids;
        });
    }
    function filterAndSortUids(uids, data) {
        return __awaiter(this, void 0, void 0, function* () {
            uids = uids.filter(uid => parseInt(uid, 10));
            let filters = data.filters || [];
            filters = Array.isArray(filters) ? filters : [data.filters];
            const fields = [];
            if (data.sortBy) {
                fields.push(data.sortBy);
            }
            filters.forEach((filter) => {
                if (filterFieldMap[filter]) {
                    fields.push(...filterFieldMap[filter]);
                }
            });
            if (data.groupName) {
                const isMembers = yield groups_1.default.isMembers(uids, data.groupName);
                uids = uids.filter((uid, index) => isMembers[index]);
            }
            if (!fields.length) {
                return uids;
            }
            if (filters.includes('banned') || filters.includes('notbanned')) {
                const isMembersOfBanned = yield groups_1.default.isMembers(uids, groups_1.default.BANNED_USERS);
                const checkBanned = filters.includes('banned');
                uids = uids.filter((uid, index) => (checkBanned ? isMembersOfBanned[index] : !isMembersOfBanned[index]));
            }
            fields.push('uid');
            let userData = yield User.getUsersFields(uids, fields);
            filters.forEach((filter) => {
                if (filterFnMap[filter]) {
                    userData = userData.filter(filterFnMap[filter]);
                }
            });
            if (data.sortBy) {
                sortUsers(userData, data.sortBy, data.sortDirection);
            }
            return userData.map(user => user.uid);
        });
    }
    function sortUsers(userData, sortBy, sortDirection) {
        if (!userData || !userData.length) {
            return;
        }
        sortDirection = sortDirection || 'desc';
        const direction = sortDirection === 'desc' ? 1 : -1;
        const isNumeric = utils_1.default.isNumber(userData[0][sortBy]);
        if (isNumeric) {
            userData.sort((u1, u2) => direction * (u2[sortBy] - u1[sortBy]));
        }
        else {
            userData.sort((u1, u2) => {
                if (u1[sortBy] < u2[sortBy]) {
                    return direction * -1;
                }
                else if (u1[sortBy] > u2[sortBy]) {
                    return direction * 1;
                }
                return 0;
            });
        }
    }
    function searchByIP(ip) {
        return __awaiter(this, void 0, void 0, function* () {
            const ipKeys = yield database_1.default.scan({ match: `ip:${ip}*` });
            const uids = yield database_1.default.getSortedSetRevRange(ipKeys, 0, -1);
            return lodash_1.default.uniq(uids);
        });
    }
    // From ChatGPT: Define a custom function to measure elapsed time
    function ElapsedTimeSince(startTime) {
        const elapsed = process.hrtime(startTime);
        return ((elapsed[0] * 1000) + (elapsed[1] / 1e6));
    }
};
exports.myFunction = myFunction;

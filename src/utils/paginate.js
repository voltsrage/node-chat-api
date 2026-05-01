export function paginatedResponse(items, total, page, pageSize){
    return{
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total/pageSize),
    };  
}

export function parsePaginationQuery(query, defaults = {page: 1, pageSize: 20}){
    const page = Math.max(1, parseInt(query.page) || defaults.page);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || defaults.pageSize));

    return {page, pageSize, skip: (page - 1) * pageSize};
}
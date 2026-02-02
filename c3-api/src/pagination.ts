export type PaginationSummary = {
  page_size:      number,
  page_number:    number,
  total_pages:    number,
  total_entries:  number,
};



// For a list of results, get the specified page, based on page size.
export function getPageData<T>(
  results:    T[],
  pageSize:   number,
  pageNumber: number,
): [ T[], PaginationSummary ] {

  // Global page size limit of 1000 results
  pageSize = Math.min(pageSize, 1000);

  const page = results.slice(
    (pageNumber - 1) * pageSize,
    pageNumber * pageSize,
  );
  const summary = {
    page_size:     pageSize,
    page_number:   pageNumber,
    total_pages:   Math.ceil(results.length / pageSize),
    total_entries: results.length,
  };
  return [ page, summary ];
}

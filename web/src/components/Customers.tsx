import { useEffect, useMemo, useState } from 'react';
import { fetchCustomers, type CustomerStatus, type CustomerSummary } from '../api';
import { formatFullDate, formatValue } from '../format';

/**
 * The customer population, searchable.
 *
 * Search runs on the server rather than by filtering a downloaded list: the
 * whole point is to find one merchant among tens of thousands from a support
 * ticket, and shipping the population to the browser to do that would trade a
 * millisecond of SQLite for megabytes over the wire.
 */

const PAGE_SIZE = 50;

export const STATUS_LABEL: Record<CustomerStatus, string> = {
  paying: 'Paying',
  trialing: 'On trial',
  installed: 'Installed',
  churned: 'Churned',
  gone: 'Uninstalled',
};

const SORTS = [
  { value: 'mrr', label: 'Highest MRR' },
  { value: 'lifetime', label: 'Most paid' },
  { value: 'recent', label: 'Most recent activity' },
  { value: 'name', label: 'Name' },
];

export function StatusPill({ status }: { status: CustomerStatus }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Waits for the typing to stop before asking the server. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function Customers({ appId }: { appId: string }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('mrr');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CustomerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debounced = useDebounced(search, 250);

  // A new search starts at the beginning; keeping the offset would silently
  // show page four of a result set the reader has not seen page one of.
  useEffect(() => {
    setPage(0);
  }, [debounced, sort, appId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCustomers({
      search: debounced,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      appId,
    })
      .then((result) => {
        if (cancelled) return;
        setRows(result.customers);
        setTotal(result.total);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, sort, page, appId]);

  const currency = useMemo(
    () => rows.find((row) => row.currency)?.currency ?? null,
    [rows],
  );

  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);

  return (
    <>
      <div className="controls">
        <div className="control control-search">
          <label htmlFor="customer-search">Find a merchant</label>
          <input
            id="customer-search"
            type="search"
            placeholder="Store name or myshopify domain"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control">
          <label htmlFor="customer-sort">Order by</label>
          <select id="customer-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
            {SORTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <p className="control-note">
          {loading && rows.length === 0
            ? 'Searching…'
            : `${total.toLocaleString()} merchant${total === 1 ? '' : 's'}${
                debounced ? ` matching “${debounced}”` : ''
              }.`}
        </p>
      </div>

      {error ? (
        <div className="notice error">
          <h2>Could not load customers</h2>
          <p>{error}</p>
        </div>
      ) : null}

      {!error && !loading && rows.length === 0 ? (
        <div className="notice">
          <h2>No merchants found</h2>
          <p>
            {debounced
              ? 'Nothing matches that name or domain. Search matches the store name and the myshopify domain.'
              : 'Run npm run sync to pull your Partner API history, then reload.'}
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="card full">
          <div className="table-wrap">
            <table className="customer-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Status</th>
                  <th>MRR</th>
                  <th>Paid to date</th>
                  <th>Apps</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.shopId}>
                    <td>
                      <a className="customer-link" href={`#/customers/${row.shopId}`}>
                        <span className="customer-name">{row.name ?? row.domain ?? row.shopId}</span>
                        <span className="customer-domain">{row.domain ?? row.shopId}</span>
                      </a>
                    </td>
                    <td>
                      <StatusPill status={row.status} />
                    </td>
                    <td>{formatValue(row.mrr, 'money', row.currency ?? currency)}</td>
                    <td>{formatValue(row.lifetimeGross, 'money', row.currency ?? currency)}</td>
                    <td>{row.activeInstalls || '—'}</td>
                    <td>{row.lastEventAt ? formatFullDate(row.lastEventAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE ? (
            <div className="pager">
              <button type="button" onClick={() => setPage((n) => n - 1)} disabled={page === 0}>
                Previous
              </button>
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{' '}
                {total.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPage((n) => n + 1)}
                disabled={page >= lastPage}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

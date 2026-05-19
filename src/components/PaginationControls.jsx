import React from 'react';

export function clampPaginationPage(page, totalPages) {
  const safeTotalPages = Math.max(1, Number(totalPages) || 1);
  const safePage = Number(page) || 1;
  return Math.min(Math.max(1, safePage), safeTotalPages);
}

export function getPaginatedItems(items, currentPage, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const safePageSize = Math.max(1, Number(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(list.length / safePageSize));
  const safePage = clampPaginationPage(currentPage, totalPages);
  const startIndex = (safePage - 1) * safePageSize;
  return list.slice(startIndex, startIndex + safePageSize);
}

export default function PaginationControls({ className = '', currentPage, label = 'items', onPageChange, pageSize, totalCount }) {
  const safeTotalCount = Math.max(0, Number(totalCount) || 0);
  const safePageSize = Math.max(1, Number(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(safeTotalCount / safePageSize));

  if (totalPages <= 1) {
    return null;
  }

  const safePage = clampPaginationPage(currentPage, totalPages);
  const start = safeTotalCount ? (safePage - 1) * safePageSize + 1 : 0;
  const end = Math.min(safeTotalCount, safePage * safePageSize);
  const normalizedLabel = String(label || 'items').toLowerCase();

  return (
    <div className={`pagination-controls ${className}`.trim()}>
      <button
        aria-label={`Previous ${normalizedLabel} page`}
        className="pagination-button"
        disabled={safePage <= 1}
        onClick={() => onPageChange?.(safePage - 1)}
        type="button"
      >
        &lt;
      </button>
      <span className="pagination-label">
        {start}-{end} of {safeTotalCount} | Page {safePage} of {totalPages}
      </span>
      <button
        aria-label={`Next ${normalizedLabel} page`}
        className="pagination-button"
        disabled={safePage >= totalPages}
        onClick={() => onPageChange?.(safePage + 1)}
        type="button"
      >
        &gt;
      </button>
    </div>
  );
}

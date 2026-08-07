/** Loading indicators: spinner for short waits, skeletons matching content shape. */

export function Spinner({ label = 'Loading', size = 28 }: { label?: string; size?: number }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-2 text-gray-500">
      <svg
        className="animate-spin"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** Board skeleton: three ghost columns with ghost cards. */
export function BoardSkeleton() {
  return (
    <div className="p-4 animate-pulse" aria-busy="true" aria-label="Loading board">
      <div className="h-6 w-48 bg-gray-300 rounded mb-4" />
      <div className="flex gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-gray-200/70 rounded-xl p-2 w-64 shrink-0 space-y-2">
            <div className="h-4 w-24 bg-gray-300 rounded" />
            {[0, 1].map((j) => (
              <div key={j} className="bg-white rounded-lg border p-2 space-y-2">
                <div className="h-4 w-full bg-gray-200 rounded" />
                <div className="h-3 w-2/3 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Generic list/tile skeleton. */
export function TileSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="bg-white rounded-lg border p-4 space-y-2">
          <div className="h-4 w-1/3 bg-gray-200 rounded" />
          <div className="h-3 w-2/3 bg-gray-200 rounded" />
        </div>
      ))}
    </div>
  );
}

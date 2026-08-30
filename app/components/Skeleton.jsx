export function SkeletonBlock({ className = "" }) {
  return <div className={`animate-pulse rounded-xl bg-surface-2/70 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8" aria-busy="true" aria-label="Carregando painel">
      <div className="flex items-center justify-between mb-6">
        <SkeletonBlock className="h-8 w-40" />
        <SkeletonBlock className="h-9 w-44" />
      </div>
      <SkeletonBlock className="h-28 mb-6" />
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
      <SkeletonBlock className="h-40 mb-6" />
      <SkeletonBlock className="h-56 mb-6" />
      <SkeletonBlock className="h-72" />
    </div>
  );
}

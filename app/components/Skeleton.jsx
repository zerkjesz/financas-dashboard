import PageContainer from "./ui/PageContainer.jsx";

export function SkeletonBlock({ className = "" }) {
  return <div className={`animate-pulse rounded-xl bg-surface-2/70 ${className}`} />;
}

export function DashboardSkeleton() {
  return (
    <PageContainer aria-busy="true" aria-label="Carregando painel">
      <div className="flex items-center justify-between mb-6">
        <SkeletonBlock className="h-8 w-40" />
        <SkeletonBlock className="h-9 w-44" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <SkeletonBlock className="h-28" />
        <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
      </div>
      <SkeletonBlock className="h-20 mb-4" />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-4">
        <SkeletonBlock className="h-56 lg:col-span-7" />
        <SkeletonBlock className="h-56 lg:col-span-5" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-4">
        <SkeletonBlock className="h-64 lg:col-span-5" />
        <SkeletonBlock className="h-64 lg:col-span-4" />
        <SkeletonBlock className="h-64 lg:col-span-3" />
      </div>
      <SkeletonBlock className="h-72" />
    </PageContainer>
  );
}

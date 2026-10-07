import { ClientOnly } from '@/components/ClientOnly';
import { Overview } from '@/components/Overview';

export default function OverviewPage() {
  return (
    <ClientOnly fallback={<div className="loading">Loading repository…</div>}>
      <Overview />
    </ClientOnly>
  );
}

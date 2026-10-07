import { ClientOnly } from '@/components/ClientOnly';
import { DiffView } from '@/components/DiffView';

export default function DiffPage() {
  return (
    <ClientOnly fallback={<div className="loading">Loading diff…</div>}>
      <DiffView />
    </ClientOnly>
  );
}

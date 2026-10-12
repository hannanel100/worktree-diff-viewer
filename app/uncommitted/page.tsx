import { ClientOnly } from '@/components/ClientOnly';
import { UncommittedView } from '@/components/UncommittedView';

export default function UncommittedPage() {
  return (
    <ClientOnly fallback={<div className="loading">Loading uncommitted changes…</div>}>
      <UncommittedView />
    </ClientOnly>
  );
}

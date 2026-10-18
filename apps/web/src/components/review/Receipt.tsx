import type { UploadReceipt } from '@/api/types'
import { CopyButton } from '@/components/primitives/CopyButton'
import { fmtBytes, fmtCountdown } from '@/lib/format'

const RULE: Record<string, string> = { github_pat: 'GitHub token', entropy: 'High entropy', identity: 'Identity terms', aws: 'AWS key', stripe: 'Stripe key' }

export function Receipt({ r }: { r: UploadReceipt }) {
  const hits = Object.values(r.hitsByRule).reduce((a, b) => a + b, 0)
  return (
    <div>
      <div className="flex items-baseline justify-between text-ui">
        <div className="font-medium">Upload receipt</div>
        <div className="text-caption text-text-2 tnum">{hits} redactions on device</div>
      </div>
      <dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-2 text-ui">
        <dt className="text-text-2">Size</dt>
        <dd className="tnum">{fmtBytes(r.bytes)}</dd>
        <dt className="text-text-2">sha256</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-caption">{r.sha256}</span>
          <CopyButton value={r.sha256} label="Copy" className="shrink-0" />
        </dd>
        <dt className="text-text-2">Caught</dt>
        <dd className="tnum">
          {Object.entries(r.hitsByRule)
            .map(([k, v]) => `${RULE[k] ?? k} ${v}`)
            .join(', ')}
        </dd>
        <dt className="text-text-2">Deleted in</dt>
        <dd className="tnum">{r.droppedDigest ? 'Already deleted' : fmtCountdown(r.deletesAt)}</dd>
      </dl>
    </div>
  )
}

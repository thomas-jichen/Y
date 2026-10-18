import type { UploadReceipt } from '@/api/types'
import { Chip } from '@/components/primitives/Chip'
import { CopyButton } from '@/components/primitives/CopyButton'
import { fmtBytes, fmtCountdown } from '@/lib/format'

const RULE: Record<string, string> = { github_pat: 'GitHub token', entropy: 'High entropy', identity: 'Identity terms', aws: 'AWS key', stripe: 'Stripe key' }

export function Receipt({ r }: { r: UploadReceipt }) {
  const hits = Object.values(r.hitsByRule).reduce((a, b) => a + b, 0)
  return (
    <div className="rounded-[12px] border border-line p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-medium">Upload receipt</div>
        <div className="text-xs text-fg-3">{hits} redactions on device</div>
      </div>
      <dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-2 text-[13px]">
        <dt className="text-fg-3">Size</dt>
        <dd className="tnum">{fmtBytes(r.bytes)}</dd>
        <dt className="text-fg-3">sha256</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs">{r.sha256}</span>
          <CopyButton value={r.sha256} label="Copy" className="shrink-0" />
        </dd>
        <dt className="text-fg-3">Caught</dt>
        <dd className="flex flex-wrap gap-1.5">
          {Object.entries(r.hitsByRule).map(([k, v]) => (
            <Chip key={k} tone="ice">
              {RULE[k] ?? k} <span className="tnum opacity-70">{v}</span>
            </Chip>
          ))}
        </dd>
        <dt className="text-fg-3">Deleted in</dt>
        <dd className="tnum">{r.droppedDigest ? 'Already deleted' : fmtCountdown(r.deletesAt)}</dd>
      </dl>
    </div>
  )
}

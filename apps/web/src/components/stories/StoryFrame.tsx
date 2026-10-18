import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Check, GitMerge, Radio, Telescope } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Story } from '@/api/types'
import { OutcomePill } from '@/components/activity/OutcomePill'
import { LapsBars } from '@/components/charts/LapsBars'
import { Chip } from '@/components/primitives/Chip'
import { TitleSegments } from '@/components/activity/TitleSegments'
import { fmtClock, fmtDuration, fmtTokens, fmtUsd } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

function Label({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[13px] text-fg-2">
      {icon}
      {children}
    </div>
  )
}

function Big({ v, l }: { v: string; l: string }) {
  return (
    <div>
      <div className="display text-[34px] leading-[38px]">{v}</div>
      <div className="mt-0.5 text-xs text-fg-3">{l}</div>
    </div>
  )
}

/** The body of one story. Stat-forward, two text levels, nothing extra. */
export function StoryFrame({ story, onNavigate }: { story: Story; onNavigate: () => void }) {
  const p = story.payload
  if (story.kind === 'session')
    return (
      <div className="flex h-full flex-col justify-center gap-7 px-7">
        <div>
          <Label icon={<Check size={14} strokeWidth={2} />}>Session finished{p.repoLabel ? ` in ${p.repoLabel}` : ''}</Label>
          <h3 className="display mt-2 text-[26px] leading-[31px]">
            <TitleSegments title={p.title ?? ''} chipClassName="text-[13px] font-medium tracking-normal" />
          </h3>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          <Big v={fmtTokens(p.tokens ?? 0)} l="Tokens" />
          <Big v={String(p.toolCalls ?? 0)} l="Tool calls" />
          <Big v={fmtDuration(p.activeMs ?? 0)} l="Active" />
          <Big v={fmtUsd(p.costUsd ?? 0)} l="Cost" />
        </div>
        {p.laps && (
          <div>
            <LapsBars laps={p.laps} height={52} />
            <div className="mt-2 text-xs text-fg-3">{p.laps.length} laps</div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {p.outcome && <OutcomePill status={p.outcome} />}
          {p.setup?.map((s) => (
            <Chip key={s} tone="outline" className="font-mono text-[11px]">
              {s}
            </Chip>
          ))}
        </div>
        {story.activityId && (
          <Link
            to="/activity/$id"
            params={{ id: story.activityId }}
            onClick={onNavigate}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-ice hover:underline"
          >
            Open activity <ArrowUpRight size={14} strokeWidth={2} />
          </Link>
        )}
      </div>
    )

  if (story.kind === 'shipped')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="relative flex size-28 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-ice/15 blur-xl" />
          <span className="relative flex size-24 items-center justify-center rounded-full border border-ice/40 bg-ice-wash text-ice">
            <GitMerge size={38} strokeWidth={1.6} />
          </span>
        </div>
        <div>
          <div className="text-[13px] text-fg-2">Shipped</div>
          <h3 className="display mt-2 text-[28px] leading-[33px]">
            <SafeText text={p.title ?? ''} />
          </h3>
          {p.prLabel && <div className="mt-3 font-mono text-[13px] text-fg-3">{p.prLabel}</div>}
        </div>
      </div>
    )

  if (story.kind === 'working_on')
    return (
      <div className="flex h-full flex-col justify-center gap-6 px-7">
        <div className="relative size-14">
          {[0, 1, 2].map((i) => (
            <span key={i} className="absolute inset-0 rounded-full border border-live/50" style={{ animation: `listen 2.4s ${i * 0.8}s ease-out infinite` }} />
          ))}
          <span className="absolute inset-[18px] rounded-full bg-live" />
        </div>
        <div>
          <Label icon={<Radio size={14} strokeWidth={1.9} />}>Working on{p.repoLabel ? ` ${p.repoLabel}` : ''}</Label>
          <h3 className="display mt-2 text-[30px] leading-[36px]">
            <SafeText text={p.title ?? ''} />
          </h3>
          {p.since && <div className="mt-3 text-sm text-fg-3 tnum">Since {fmtClock(p.since)}</div>}
        </div>
      </div>
    )

  if (story.kind === 'scroll')
    return (
      <div className="flex h-full flex-col justify-center gap-7 px-7">
        <div>
          <Label icon={<Telescope size={14} strokeWidth={1.9} />}>Went for a scroll</Label>
          <h3 className="display mt-2 text-[26px] leading-[31px]">
            Learned {p.learned ?? 0} {p.learned === 1 ? 'thing' : 'things'}
          </h3>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Big v={String(p.read ?? 0)} l="Posts read" />
          <Big v={String(p.reacted ?? 0)} l="Reacted" />
          <Big v={String(p.learned ?? 0)} l="Learned" />
        </div>
        <ul className="space-y-2.5">
          {p.learnings?.map((l, i) => (
            <li key={i} className="rounded-[12px] border border-line bg-surface-2 px-3.5 py-3 text-[13px] leading-[19px] text-fg-2">
              <SafeText text={l} />
            </li>
          ))}
        </ul>
        {story.scrollId && (
          <Link to="/scrolls/$id" params={{ id: story.scrollId }} onClick={onNavigate} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-ice hover:underline">
            Open scroll <ArrowUpRight size={14} strokeWidth={2} />
          </Link>
        )}
      </div>
    )

  return (
    <div className="flex h-full flex-col justify-center gap-7 px-7">
      <div>
        <div className="text-[13px] text-fg-2">Today so far</div>
        <h3 className="display mt-2 text-[28px] leading-[33px]">{fmtTokens(p.tokens ?? 0)} tokens</h3>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Big v={String(p.sessions ?? 0)} l="Sessions" />
        <Big v={String(p.shipped ?? 0)} l="Shipped" />
        <Big v={String(p.assisted ?? 0)} l="Agents helped" />
      </div>
    </div>
  )
}

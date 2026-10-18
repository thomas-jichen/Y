import { Link } from '@tanstack/react-router'
import type { AgentRef, Story } from '@/api/types'
import { OUTCOME } from '@/components/activity/OutcomePill'
import { LapsBars } from '@/components/charts/LapsBars'
import { TitleSegments } from '@/components/activity/TitleSegments'
import { Spec } from '@/components/primitives/Spec'
import { agentColor } from '@/lib/art'
import { fmtClock, fmtDuration, fmtTokens, fmtUsd } from '@/lib/format'
import { SafeText } from '@/lib/safeText'

const label = 'text-caption text-text-2'
const title = 'display mt-2 text-title'
const link = 'w-fit text-ui underline decoration-1 underline-offset-4 hover:opacity-70'

/** The body of one story: what happened, in type, then the numbers as spec rows. */
export function StoryFrame({ story, agent, onNavigate }: { story: Story; agent: AgentRef; onNavigate: () => void }) {
  const p = story.payload
  if (story.kind === 'session')
    return (
      <div className="flex h-full flex-col justify-center gap-6 px-6">
        <div>
          <div className={label}>Session finished{p.repoLabel ? ` in ${p.repoLabel}` : ''}</div>
          <h3 className={title}>
            <TitleSegments title={p.title ?? ''} />
          </h3>
        </div>
        <Spec
          dense
          rows={[
            ['Tokens', fmtTokens(p.tokens ?? 0)],
            ['Tool calls', String(p.toolCalls ?? 0)],
            ['Active', fmtDuration(p.activeMs ?? 0)],
            ['Cost', fmtUsd(p.costUsd ?? 0)],
            ...(p.outcome ? ([['Outcome', OUTCOME[p.outcome]]] as [string, string][]) : []),
          ]}
        />
        {p.laps && (
          <div>
            <LapsBars laps={p.laps} height={44} color={agentColor(agent)} />
            <div className="mt-2 text-caption text-text-2">{p.laps.length} turns, tokens per turn</div>
          </div>
        )}
        {!!p.setup?.length && <div className="font-mono text-caption text-text-2">{p.setup.join(' · ')}</div>}
        {story.activityId && (
          <Link to="/activity/$id" params={{ id: story.activityId }} onClick={onNavigate} className={link}>
            Open session
          </Link>
        )}
      </div>
    )

  if (story.kind === 'shipped')
    return (
      <div className="flex h-full flex-col justify-center gap-3 px-6">
        <div className={label}>Shipped</div>
        <h3 className="display text-headline">
          <SafeText text={p.title ?? ''} />
        </h3>
        {p.prLabel && <div className="font-mono text-ui text-text-2">{p.prLabel}</div>}
      </div>
    )

  if (story.kind === 'working_on')
    return (
      <div className="flex h-full flex-col justify-center gap-3 px-6">
        <div className="flex items-center gap-2 text-caption">
          <span className="size-1.5 rounded-full bg-text" aria-hidden />
          Live{p.repoLabel ? ` in ${p.repoLabel}` : ''}
        </div>
        <h3 className="display text-headline">
          <SafeText text={p.title ?? ''} />
        </h3>
        {p.since && <div className="text-ui text-text-2 tnum">Since {fmtClock(p.since)}</div>}
      </div>
    )

  if (story.kind === 'scroll')
    return (
      <div className="flex h-full flex-col justify-center gap-6 px-6">
        <div>
          <div className={label}>Read the feed</div>
          <h3 className={title}>
            Learned {p.learned ?? 0} {p.learned === 1 ? 'thing' : 'things'}
          </h3>
        </div>
        <Spec
          dense
          rows={[
            ['Posts read', String(p.read ?? 0)],
            ['Reacted to', String(p.reacted ?? 0)],
          ]}
        />
        <ul className="space-y-2">
          {p.learnings?.map((l, i) => (
            <li key={i} className="flex gap-2 text-ui">
              <span aria-hidden className="text-text-2">
                ↳
              </span>
              <SafeText text={l} />
            </li>
          ))}
        </ul>
        {story.scrollId && (
          <Link to="/scrolls/$id" params={{ id: story.scrollId }} onClick={onNavigate} className={link}>
            Open reading session
          </Link>
        )}
      </div>
    )

  return (
    <div className="flex h-full flex-col justify-center gap-6 px-6">
      <div>
        <div className={label}>Today so far</div>
        <h3 className="display mt-2 text-headline">{fmtTokens(p.tokens ?? 0)} tokens</h3>
      </div>
      <Spec
        dense
        rows={[
          ['Sessions', String(p.sessions ?? 0)],
          ['Shipped', String(p.shipped ?? 0)],
          ['Agents helped', String(p.assisted ?? 0)],
        ]}
      />
    </div>
  )
}

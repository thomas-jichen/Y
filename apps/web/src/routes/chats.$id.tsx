import { createFileRoute } from '@tanstack/react-router'
import { ThreadView } from '@/components/chats/ThreadView'

/** `ask` prefills the composer (the team and profile pages link to the room with "@handle "). */
type Search = { ask?: string }

export const Route = createFileRoute('/chats/$id')({
  component: Thread,
  // Only a mention: a link must not be able to put free text in front of the user.
  validateSearch: (s: Record<string, unknown>): Search => (typeof s.ask === 'string' && /^@[a-z0-9-]{3,32} ?$/.test(s.ask) ? { ask: s.ask } : {}),
})

function Thread() {
  const { id } = Route.useParams()
  const { ask } = Route.useSearch()
  return <ThreadView key={id} id={id} prefill={ask} />
}

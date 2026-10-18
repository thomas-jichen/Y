import { createFileRoute } from '@tanstack/react-router'
import { ThreadView } from '@/components/chats/ThreadView'

export const Route = createFileRoute('/chats/$id')({ component: Thread })

function Thread() {
  const { id } = Route.useParams()
  return <ThreadView key={id} id={id} />
}

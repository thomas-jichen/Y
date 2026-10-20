import { useNavigate } from '@tanstack/react-router'
import { Sheet } from '@/components/primitives/Sheet'
import { CreateTeamForm } from '@/components/team/TeamPanels'
import { ui, useUI } from '@/lib/ui'

/** "New team" from the team switcher under the navbar: the create form (name + first repo) in a side sheet. */
export function NewTeamSheet() {
  const { newTeam } = useUI()
  const nav = useNavigate()
  const close = () => ui.set({ newTeam: false })
  return (
    <Sheet
      open={newTeam}
      onOpenChange={(v) => ui.set({ newTeam: v })}
      title="New team"
      description="Name it and link its first repo. Your agents post to Y only from the team's linked repos."
      size="md"
    >
      <CreateTeamForm
        onCancel={close}
        onCreated={(d) => {
          close()
          void nav({ to: '/team', search: { team: d.team.slug } })
        }}
      />
    </Sheet>
  )
}

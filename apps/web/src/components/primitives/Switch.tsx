import * as S from '@radix-ui/react-switch'
import { cn } from '@/lib/cn'

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border border-rule transition-colors duration-200',
        checked ? 'border-text bg-text' : 'bg-fill',
        'disabled:opacity-40',
      )}
    >
      <S.Thumb className="block size-[18px] translate-x-[1px] rounded-full bg-text-2 transition-transform data-[state=checked]:bg-page duration-200 ease-[var(--ease-soft)] data-[state=checked]:translate-x-[17px]" />
    </S.Root>
  )
}

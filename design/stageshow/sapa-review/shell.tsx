import logoWhite from './freedom-logo-white.svg'

// The Sapa product bar, shared by every screen: the Freedom mark, the product
// name and the two sections, the current one lit. It goes in the Window's
// `lead` slot so the window's own unified toolbar is the green bar.
export type Section = 'dialogs' | 'sheet'

export function SapaLead({ active }: { active: Section }) {
  return (
    <span className="sp-brand">
      <img className="sp-logo" src={logoWhite} alt="Freedom" />
      <span className="sp-sep" />
      <span className="sp-name">Sapa</span>
      <span className="sp-nav">
        <span className="sp-nav__item" data-active={active === 'dialogs' || undefined}>Диалоги</span>
        <span className="sp-nav__item" data-active={active === 'sheet' || undefined}>Оценочный лист</span>
      </span>
    </span>
  )
}

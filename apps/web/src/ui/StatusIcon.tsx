/**
 * Figma's Check Circled / X Circled: a green or red circle with a mark that follows the theme, black in dark mode and
 * white in light, like the text on the blue buttons (`--on-accent`; Gold, 13 Nov). Used by the email field's tick and
 * cross and the Send "Sent" screen. Inline SVG because an <img> can't take the theme's colour.
 */
export function StatusIcon({ kind, size = 24, className }: { kind: 'ok' | 'bad'; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24.0519 24.0519" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <path
        d="M12.0245 1.41129C17.8892 1.41133 22.6443 6.16583 22.6447 12.0304C22.6447 17.8953 17.8894 22.6505 12.0245 22.6505C6.15976 22.6503 1.4054 17.8952 1.4054 12.0304C1.40578 6.16593 6.16 1.41149 12.0245 1.41129Z"
        fill={kind === 'ok' ? '#22C55E' : '#DC2626'}
      />
      <path
        d={kind === 'ok' ? 'M15.6336 8.41811L10.556 15.6337L8.0172 13.0479' : 'M15.2 8.85L8.85 15.2M8.85 8.85L15.2 15.2'}
        stroke="var(--on-accent)"
        strokeWidth={1.60346}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

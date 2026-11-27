/**
 * What the reader took this document to be, with a button to change it when
 * it guessed wrong ("Read as a bill · Change to booking").
 */
export function KindRow({ kind, onChange, disabled = false }: { kind: 'bill' | 'booking'; onChange: () => void; disabled?: boolean }) {
  const other = kind === 'bill' ? 'booking' : 'bill'
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 t-callout" data-testid="scan-kind"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
      <span className="min-w-0">Read as a {kind}</span>
      <button type="button" onClick={onChange} disabled={disabled} className="min-h-9 shrink-0 whitespace-nowrap rounded-full border px-3 t-footnote t-medium"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}>Change to {other}</button>
    </div>
  )
}

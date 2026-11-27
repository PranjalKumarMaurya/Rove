import { ScreenHeader } from '../../components/ui/ScreenHeader'

/**
 * In-app Privacy policy and Terms. The wording below is a PLACEHOLDER for the
 * product owner to replace with reviewed text before launch.
 */
const pages = {
  privacy: {
    title: 'Privacy policy',
    sections: [
      ['What we keep', 'Your account email, the name and photo you choose, and what you add to your Trips: plans, todos, expenses, documents and crew info.'],
      ['Who sees it', 'Only people in the same Trip see what you add to it. Your phone, emergency contact and dietary notes are visible only to people in your Trips.'],
      ['Deleting your data', 'You can delete your account from Profile. Your profile and photo are removed; what you added to a Trip stays for the others and shows as a former member.'],
      ['Contact', 'Questions about your data go to the support address in Help & feedback.'],
    ],
  },
  terms: {
    title: 'Terms of use',
    sections: [
      ['Using the app', 'Rove helps friends plan a trip together. Use it for trips you are part of, and only add things you are allowed to share.'],
      ['Money', 'Split shows who owes whom. It records payments you make outside the app; it does not move money.'],
      ['Exchange rates', 'Rates are references only. Check the rate you were actually charged.'],
      ['Changes', 'We may update these terms. We will tell you in the app when we do.'],
    ],
  },
} as const

export function LegalPage({ kind, onBack }: { kind: keyof typeof pages; onBack: () => void }) {
  const page = pages[kind]
  return (
    // A screen pushed above Profile: the same header and gutter as a Trip's To-dos and Settings.
    <main data-testid={`legal-${kind}`} className="pushed-screen">
      <ScreenHeader title={page.title} subtitle="Profile" onBack={onBack} backLabel="Back to Profile" />
      <div className="pushed-content">
        <p role="note" className="notice notice--error" data-testid="legal-placeholder" data-layout="section">
          Placeholder text — the owner will replace this page with the final {page.title.toLowerCase()} before launch.
        </p>
        {page.sections.map(([heading, body]) => (
          <section key={heading} className="section" data-layout="section">
            <h2 className="t-title3" style={{ color: 'var(--text-primary)' }}>{heading}</h2>
            <p className="t-body" style={{ color: 'var(--text-secondary)' }}>{body}</p>
          </section>
        ))}
      </div>
    </main>
  )
}

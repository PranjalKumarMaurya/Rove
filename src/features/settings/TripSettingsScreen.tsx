import { ScreenHeader } from '../../components/ui/ScreenHeader'
import { CrewSettings } from '../crew/CrewSettings'
import type { MyGroupAccess } from '../groups/myGroupAccess'
import { useGroupRoster } from '../groups/useGroupRoster'
import { TripDetailsSection } from './TripDetailsSection'

/**
 * A Trip's Settings as a full screen, pushed above the Trip from its header
 * (View `{ kind: 'settings' }`). Sections, 24px apart:
 *   1. Trip details: name, destination, dates, timezone, international, currency
 *      (Owner edits; Members read);
 *   2. People: the crew with info and Manage actions, roles, Refresh crew;
 *   3. Invite: the Trip's invite link, then one-person email invitations (Owner);
 *   4. Danger zone: leave the Trip; archive it (Owner).
 */
export function TripSettingsScreen({ trip, onBack, onTripsChanged }: {
  trip: MyGroupAccess
  onBack: () => void
  /** Re-read the Trip list (settings saved, role changed, left, archived). */
  onTripsChanged: () => void
}) {
  const { roster, reload } = useGroupRoster(trip.groupId)
  const owner = trip.role === 'owner'
  return (
    <main data-testid="trip-settings" className="pushed-screen">
      <ScreenHeader title="Settings" subtitle={`${trip.tripName} · ${owner ? 'Owner' : 'Member'}`} onBack={onBack}
        backLabel={`Back to ${trip.tripName}`} />
      <div className="pushed-content">
        <TripDetailsSection trip={trip} onSaved={onTripsChanged} />
        <CrewSettings trip={trip} roster={roster} reloadRoster={reload} onTripsChanged={onTripsChanged} />
      </div>
    </main>
  )
}

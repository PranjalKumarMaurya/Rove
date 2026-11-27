import { ScreenHeader } from '../../components/ui/ScreenHeader'
import type { MyGroupAccess } from '../groups/myGroupAccess'
import { useGroupRoster } from '../groups/useGroupRoster'
import { TodosTab } from './TodosTab'

/**
 * The Trip's To-dos as a full screen, pushed above the Trip from its header
 * (View `{ kind: 'todos' }`): back returns to the Trip, as does the edge swipe.
 */
export function TripTodosScreen({ trip, onBack }: { trip: MyGroupAccess; onBack: () => void }) {
  const { roster, reload } = useGroupRoster(trip.groupId)
  return (
    <main data-testid="trip-todos" className="pushed-screen">
      <ScreenHeader title="To-dos" subtitle={trip.tripName} onBack={onBack} backLabel={`Back to ${trip.tripName}`} />
      <div className="pushed-content">
        <TodosTab trip={trip} roster={roster} reloadRoster={reload} />
      </div>
    </main>
  )
}

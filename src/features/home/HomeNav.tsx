import { IconPlus, IconSuitcase } from '../../components/ui/icons'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { useAvatarUrl } from '../profile/avatarStorage'
import type { MyProfile } from '../profile/profileApi'
import './home.css'

export type HomeNavItem = 'trips' | 'profile'

/**
 * The bottom bar outside a Trip, within thumb reach: Trips, a raised ＋ that
 * creates a Trip, and the person's avatar for Profile. Fixed to the bottom and
 * tucked close to the iPhone home indicator; the screen above must leave room
 * for it (`.home-nav-space`).
 */
export function HomeNav({ active, onTrips, onCreate, onProfile, profile, accountName }: {
  active: HomeNavItem
  onTrips: () => void
  onCreate: () => void
  onProfile: () => void
  profile: MyProfile | null
  accountName: string
}) {
  const photo = useAvatarUrl(profile?.avatarPath)
  return (
    <nav className="home-nav" aria-label="Main">
      <div className="home-nav__inner">
        <button type="button" className={`home-nav__item${active === 'trips' ? ' is-active' : ''}`}
          aria-current={active === 'trips' ? 'page' : undefined} onClick={onTrips}>
          <span className="home-nav__icon"><IconSuitcase size={24} /></span>
          <span>Trips</span>
        </button>
        <button type="button" className="home-nav__item home-nav__item--create" aria-label="Create Trip" onClick={onCreate}>
          <span className="home-nav__icon"><span className="home-nav__fab"><IconPlus size={24} /></span></span>
          <span aria-hidden="true">New trip</span>
        </button>
        <button type="button" className={`home-nav__item${active === 'profile' ? ' is-active' : ''}`}
          aria-label="Profile" aria-current={active === 'profile' ? 'page' : undefined} onClick={onProfile}>
          <span className="home-nav__icon">
            <UserAvatar size={26} className="home-nav__avatar" name={profile?.displayName || accountName}
              emoji={profile?.avatarEmoji} imageUrl={photo} />
          </span>
          <span aria-hidden="true">Profile</span>
        </button>
      </div>
    </nav>
  )
}

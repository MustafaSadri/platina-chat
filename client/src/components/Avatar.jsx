import { AVATAR_COLORS, initials } from '../lib/format.js';
import Icon from './Icons.jsx';

export default function Avatar({ name, color = 0, size = 48, online = false, group = false }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: AVATAR_COLORS[color % AVATAR_COLORS.length] }}>
      {group && !name ? <Icon name="users" size={size * 0.5} /> : initials(name)}
      {online && <span className="avatar-online" style={{ width: size * 0.28, height: size * 0.28 }} />}
    </div>
  );
}

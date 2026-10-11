import type { AreaKind } from '../layout/types';

export type LightMode = 'presence' | 'bridge' | 'own';

/** Como uma área entra no mapa de luz: por presença (núcleo e saguão), como corredor só nos trechos (passarela) ou com luz própria. */
export function lightMode(kind: AreaKind): LightMode {
  if (kind === 'cafe' || kind === 'lounge' || kind === 'restroom' || kind === 'hub') return 'presence';
  if (kind === 'bridge') return 'bridge';
  return 'own';
}

import type { Park, Region } from '../core/types';
import type { MapRescueRow } from './map-model';
export type ParkMapProps = {
  parks: Park[];
  rescueCases: MapRescueRow[];
  region: Region;
  selected?: string;
  userLocation?: { latitude: number; longitude: number };
  onSelect: (id: string) => void;
  onSelectRescue: (id: string) => void;
  onMove: (region: Region) => void;
};

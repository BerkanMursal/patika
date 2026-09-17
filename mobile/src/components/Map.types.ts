import type { Park, Region } from '../core/types';
export type ParkMapProps = {
  parks: Park[];
  region: Region;
  selected?: string;
  userLocation?: { latitude: number; longitude: number };
  onSelect: (id: string) => void;
  onMove: (region: Region) => void;
};

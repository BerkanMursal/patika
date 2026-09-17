export type FoodType = 'dry' | 'wet' | 'other';
export type BowlStatus = 'full' | 'low' | 'empty' | 'unknown';
export type Park = {
  id: string;
  name: string;
  city: string;
  district: string;
  latitude: number;
  longitude: number;
  osm_id?: string;
  name_status?: 'source' | 'missing' | 'municipal' | 'community';
  name_source?: string;
  name_source_url?: string;
  address_label?: string;
  last_fed_at: string | null;
  last_grams: number | null;
  last_water_at: string | null;
  total_records: number;
  food_status: BowlStatus;
  water_status: BowlStatus;
  observed_at: string | null;
};
export type Point = {
  id: string;
  park_id: string;
  name: string;
  latitude: number;
  longitude: number;
};
export type Feeding = {
  id: string;
  park_id: string;
  point_id: string;
  user_id: string;
  author_name: string;
  park_name: string;
  food_type: FoodType;
  food_grams: number;
  water_ml: number;
  occurred_at: string;
  note: string;
  photo_path: string;
  photo_url?: string;
};
export type FeedingDraft = {
  id: string;
  user_id: string;
  park_id: string;
  point_id: string;
  park_name: string;
  food_type: FoodType;
  food_grams: number;
  water_ml: number;
  note: string;
  occurred_at: string;
  photo_uri: string;
  // Absent for demo drafts, which never reach submit_feeding.
  reported_latitude?: number;
  reported_longitude?: number;
};
export type Pending = FeedingDraft & {
  status: 'pending' | 'error';
  error?: string;
  attempts: number;
};
export type Observation = {
  point_id: string;
  food_status: BowlStatus;
  water_status: BowlStatus;
  note: string;
  reported_latitude: number;
  reported_longitude: number;
};
export type Viewer = { id: string; name: string; email?: string; moderator?: boolean };
export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};
export type Report = {
  id: string;
  reason: string;
  detail: string;
  status: string;
  feeding_id: string | null;
  park_id: string | null;
  created_at: string;
};
export type ReportContext = {
  park: Pick<Park, 'id' | 'name' | 'city' | 'latitude' | 'longitude'>;
  feeding: Feeding | null;
};
export type NameSuggestion = {
  id: string;
  park_id: string;
  user_id: string;
  original_name: string;
  proposed_name: string;
  evidence: string;
  status: 'pending' | 'approved' | 'rejected';
  review_note: string;
  created_at: string;
  reviewed_at: string | null;
  park_name?: string;
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
};
export type LeaderboardRow = { user_id: string; display_name: string; total_points: number };

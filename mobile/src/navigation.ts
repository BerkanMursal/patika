export type RootStack = {
  Main: undefined;
  Park: { id: string };
  Record: { id: string };
  Observe: { id: string };
  Auth: undefined;
  Reset: undefined;
  Outbox: undefined;
  MyHistory: undefined;
  Favorites: undefined;
  About: undefined;
  Privacy: undefined;
  Report: { parkId?: string; feedingId?: string };
  Moderation: undefined;
  SuggestName: { id: string };
  NameReview: undefined;
  Leaderboard: undefined;
};

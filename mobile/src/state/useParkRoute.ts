import { useCallback, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { Park } from '../core/types';
import { parkRouteAction, type ParkMessage, type ParkRouteAction } from '../core/park-lifecycle';
import { useApp } from './AppProvider';

type ParkRoute = 'Park' | 'Record' | 'Observe' | 'SuggestName';
export type ParkRouteState =
  | { kind: 'loading' }
  | { kind: 'live'; park: Park }
  | { kind: 'redirecting' }
  | { kind: 'unavailable'; message: ParkMessage };

// Shared by every screen that is opened with a park id (deep links included):
// live -> show, merged -> replace this screen with the same route for the surviving
// park (once), retired / unknown -> a plain unavailable state. Network errors are
// thrown to the caller so each screen keeps its existing offline behaviour.
export function useParkRoute(route: ParkRoute, id: string, redirectedFrom?: string) {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [state, setState] = useState<ParkRouteState>({ kind: 'loading' });
  const redirected = useRef(false);
  const resolve = useCallback(async (): Promise<ParkRouteAction> => {
    const action = parkRouteAction(await app.resolvePark(id), redirectedFrom);
    if (action.type === 'redirect') {
      if (!redirected.current) {
        redirected.current = true;
        setState({ kind: 'redirecting' });
        nav.replace(route, { id: action.id, redirectedFrom: id });
      }
    } else if (action.type === 'show') setState({ kind: 'live', park: action.park });
    else setState({ kind: 'unavailable', message: action.message });
    return action;
  }, [id, redirectedFrom, app.resolvePark]);
  return { state, resolve };
}

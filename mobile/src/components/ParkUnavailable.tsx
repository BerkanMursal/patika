import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { ParkMessage } from '../core/park-lifecycle';
import { Button, Empty } from '../ui/common';
import { C } from '../ui/theme';

// The one screen-level presentation of a park id that is no longer shown on the map.
export function ParkUnavailable({ message }: { message: ParkMessage }) {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  return (
    <View style={s.page}>
      <Empty title={message.title} detail={message.detail} icon="map-outline" />
      <Button
        secondary
        label="Haritaya dön"
        icon="map-outline"
        onPress={() => nav.navigate('Main')}
      />
    </View>
  );
}
const s = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: C.bg,
    padding: 22,
    gap: 16,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
    justifyContent: 'center',
  },
});

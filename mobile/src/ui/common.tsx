import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { C } from './theme';
export function Icon({
  name,
  size = 22,
  color = C.green,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  size?: number;
  color?: string;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
export function Button({
  label,
  onPress,
  secondary = false,
  loading = false,
  disabled = false,
  icon,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Icon>['name'];
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        destructive && { backgroundColor: C.red },
        (disabled || loading) && { opacity: 0.55 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? C.green : C.white} />
      ) : icon ? (
        <Icon name={icon} color={secondary ? C.green : C.white} size={19} />
      ) : null}
      <Text style={[s.buttonText, secondary && { color: C.green }]}>{label}</Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  onPress,
  label,
  active = false,
}: {
  name: React.ComponentProps<typeof Icon>['name'];
  onPress: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[s.iconButton, active && { backgroundColor: C.soft }]}
    >
      <Icon name={name} />
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#A1ABA4"
        {...props}
        style={[s.field, props.multiline && { height: 100, textAlignVertical: 'top' }, props.style]}
      />
    </View>
  );
}
export function Notice({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <View accessibilityRole="alert" style={[s.notice, error && { backgroundColor: '#FCF0ED' }]}>
      <Icon
        name={error ? 'alert-circle-outline' : 'information-circle-outline'}
        size={19}
        color={error ? C.red : C.green}
      />
      <Text style={[s.noticeText, error && { color: C.red }]}>{text}</Text>
    </View>
  );
}
export function Empty({
  title,
  detail,
  icon = 'leaf-outline',
}: {
  title: string;
  detail: string;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={30} />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyDetail}>{detail}</Text>
    </View>
  );
}
export function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Icon>['name'];
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[s.chip, active && s.activeChip]}
    >
      {icon ? <Icon name={icon} color={active ? C.white : C.muted} size={15} /> : null}
      <Text style={[s.chipText, active && { color: C.white }]}>{label}</Text>
    </Pressable>
  );
}
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
export const textStyles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700', color: C.ink, letterSpacing: -0.8 },
  h2: { fontSize: 20, fontWeight: '700', color: C.ink, letterSpacing: -0.4 },
  body: { fontSize: 15, color: C.muted, lineHeight: 23 },
  eyebrow: { fontSize: 11, color: C.muted, letterSpacing: 1.8, fontWeight: '700' },
});
const s = StyleSheet.create({
  button: {
    minHeight: 52,
    paddingHorizontal: 18,
    borderRadius: 15,
    backgroundColor: C.green,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  secondary: { backgroundColor: C.soft, borderWidth: 1, borderColor: C.line },
  buttonText: { fontSize: 15, fontWeight: '600', color: C.white },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.white,
    borderColor: C.line,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 13, fontWeight: '600', color: C.ink },
  field: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.white,
  },
  notice: {
    backgroundColor: C.soft,
    padding: 14,
    borderRadius: 13,
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
  },
  noticeText: { fontSize: 13, lineHeight: 20, color: C.green, flex: 1 },
  empty: { alignItems: 'center', padding: 34, gap: 11 },
  emptyIcon: {
    width: 64,
    height: 64,
    backgroundColor: C.soft,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: C.ink },
  emptyDetail: { fontSize: 14, lineHeight: 22, textAlign: 'center', color: C.muted, maxWidth: 350 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.white,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeChip: { backgroundColor: C.green, borderColor: C.green },
  chipText: { fontSize: 12, fontWeight: '600', color: C.muted },
  card: {
    backgroundColor: C.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    padding: 20,
  },
});

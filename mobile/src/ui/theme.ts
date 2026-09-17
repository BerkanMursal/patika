import { Platform } from 'react-native';
export const C = {
  ink: '#253D34',
  muted: '#819089',
  green: '#2C6953',
  dark: '#204C3E',
  lime: '#D4E5AE',
  bg: '#F7F8F4',
  white: '#FFFFFF',
  line: '#E6EBE4',
  soft: '#EDF3EB',
  amber: '#B67B3F',
  red: '#B65C52',
  blue: '#6C91A4',
};
export const shadow = Platform.select({
  web: { boxShadow: '0 8px 32px rgba(27,57,41,0.08)' },
  default: {
    shadowColor: '#173727',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
});

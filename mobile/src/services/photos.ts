import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';

export async function pickPhoto(source: 'camera' | 'library'): Promise<string | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted)
      throw new Error('Fotoğraf çekmek için kamera izni gerekiyor. Galeriden de seçebilirsiniz.');
  }
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.9,
          exif: false,
        });
  if (result.canceled) return null;
  const context = ImageManipulator.manipulate(result.assets[0].uri);
  context.resize({ width: Math.min(1280, result.assets[0].width) });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.78,
    base64: Platform.OS === 'web',
  });
  return Platform.OS === 'web' ? `data:image/jpeg;base64,${saved.base64}` : saved.uri;
}
export async function persistPhoto(uri: string, id: string) {
  if (Platform.OS === 'web') return uri;
  const target = new File(Paths.document, `patika-${id}.jpg`);
  if (target.exists) target.delete();
  new File(uri).copy(target);
  return target.uri;
}
export async function photoBytes(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS !== 'web') return new File(uri).arrayBuffer();
  return (await fetch(uri)).arrayBuffer();
}
export function removeLocalPhoto(uri: string) {
  if (Platform.OS === 'web') return;
  try {
    const file = new File(uri);
    if (file.exists && uri.startsWith(Paths.document.uri) && file.name.startsWith('patika-'))
      file.delete();
  } catch {
    /* A saved record remains valid if temporary-file cleanup fails. */
  }
}

import { Text, View } from 'react-native';

// A `+`-prefixed framework hook, not a navigable screen — it must be skipped.
export default function NotFound() {
  return (
    <View>
      <Text>Not found</Text>
    </View>
  );
}

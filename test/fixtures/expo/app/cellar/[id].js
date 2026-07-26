import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

// A dynamic screen: `[id]` becomes the `:id` parameter, so this serves `/cellar/:id`.
export default function BottleDetail() {
  const { id } = useLocalSearchParams();
  return (
    <View>
      <Text>Bottle {id}</Text>
    </View>
  );
}

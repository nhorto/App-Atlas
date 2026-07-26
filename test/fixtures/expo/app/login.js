import { Text, View } from 'react-native';

// A public screen — no session required to reach it. A screen is a way *in*, but not
// a network door, so it must never be counted as an unprotected route.
export default function Login() {
  return (
    <View>
      <Text>Sign in</Text>
    </View>
  );
}

import { StatusBar } from "expo-status-bar";
import { Button, StyleSheet, Text, View } from "react-native";
import useRecording from "./useRecording";
export default function App() {
  const { startRecording, stopRecording, recordingTime, isRecording } =
    useRecording();

    console.log(recordingTime, isRecording,'redocting')
  return (
    <View style={styles.container}>
      <Button title="recoderStart" onPress={() => startRecording()} />
      <Button title="recoderStop" onPress={() => stopRecording()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});

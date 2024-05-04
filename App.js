import { StatusBar } from "expo-status-bar";
import { Button, StyleSheet, Text, View } from "react-native";
import useRecording from "./useRecording";
export default function App() {
  const { startRecording, stopRecording, recordingTime, isRecording, startRecordingAfterDelay } =
    useRecording();
  // BackgroundTimer.runBackgroundTimer(() => {
  //   console.log('run background timer')
  // }, 3000);
  console.log(recordingTime, isRecording, "redocting");
  return (
    <View style={styles.container}>
      <Button title="recoderStart" onPress={() => startRecordingAfterDelay(60000)} />
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

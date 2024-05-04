import { AppState, Linking } from "react-native";
import { useEffect, useRef, useState } from "react";
import { Audio, InterruptionModeIOS } from "expo-av";
import { getNetworkStateAsync } from "expo-network";
import BackgroundTimer from "react-native-background-timer";

import {
  setLayoutTimeout,
  clearLayoutTimeout,
  uuid,
  loggingBuilder as logging,
} from "./utils";
import usePersistRef from "./usePersistRef";

const SNIPPET_LENGTH_IN_MILLISECONDS = 36000

let sendUpdatesTimeout: ReturnType<typeof setTimeoutCoordinator> = undefined;
let recordingTimeoutByRecordingUuid = new Map<
  string,
  ReturnType<typeof setTimeoutCoordinator>
>();
const recordingOptions = Audio.RecordingOptionsPresets.HIGH_QUALITY;
let stopRecordingCallback = { current: undefined } as {
  current: undefined | (() => Promise<void>);
};
let audioRecording: { current: Audio.Recording | undefined } = {
  current: undefined,
};

const logger = logging("useRecording");

// If the app is backgrounded we use the setTimeout function, if it's in the foreground we use the setLayoutTimeout function so it does not block the UI thread.
const setTimeoutCoordinator = (
  callback: () => void | Promise<void>,
  timeout: number,
  isInForeground = true
): ReturnType<typeof setLayoutTimeout> | ReturnType<typeof setTimeout> => {
  if (isInForeground) return setLayoutTimeout(callback, timeout);
  return setTimeout(callback, timeout);
};
const clearTimeoutCoordinator = (
  timeout: ReturnType<typeof setLayoutTimeout> | ReturnType<typeof setTimeout>
) => {
  if (timeout instanceof Function) timeout();
  else clearTimeout(timeout);
};

export default function useRecording(
  callbackForSendingRecordingDataAsBase64: (data: {
    recordingUuid: string;
    isLast: boolean;
    uri: string;
    type: string;
    batch: number;
    threadId?: string;
    duration: {
      batch: number;
      total: number;
    };
  }) => Promise<string> | string,
  withTimer = true,
  emailAddress: string | undefined = undefined
) {
  const [appState, setAppState] = useState(AppState.currentState);
  const appStateRef = useRef({
    permissions: appState,
    recording: appState,
    sending: appState,
  });
  let [permissionResponse, requestPermission] = Audio.usePermissions();
  const [permissionStatus, setPermissionStatus] = useState(
    typeof permissionResponse === "object" && permissionResponse !== null
      ? permissionResponse?.status
      : undefined
  );
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState({
    startTime: 0,
    elapsedTime: 0,
  });
  const [slackThreadsByRecordingUuidRef, retrieveSlackThreadsByRecordingUuid] =
    usePersistRef<Record<string, string>>(`slackThreadsByRecordingUuid`, {});
  const [recordingBatchesRef, retrieveRecordingBatches] = usePersistRef<
    {
      uuid: string;
      uri: string;
      type: string;
      batch: number;
      isLast: boolean;
      duration: {
        batch: number;
        total: number;
      };
    }[]
  >(`recordingBatches`, []);



  async function askForPermission() {
    const requestPermissionResponse = await requestPermission();
    setPermissionStatus(requestPermissionResponse.status);
    permissionResponse = requestPermissionResponse;
    return permissionResponse;
  }

  async function setAudioMode(hasStopped: boolean = false) {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: hasStopped ? false : true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      staysActiveInBackground: true,
    });
  }

  function pushDataToStack(
    recordingUuid: string,
    uri: string,
    batch: number,
    isLastRecording: boolean,
    duration: { batch: number; total: number }
  ) {
    const fileType = uri.split(".").pop();
    logger.log("Pushing data to stack", emailAddress, {
      recordingUuid,
      uri,
      batch,
      isLastRecording,
      duration,
    });
    retrieveRecordingBatches().then((recordingBatch) => {
      recordingBatchesRef.current = (recordingBatch || []).concat([
        {
          uuid: recordingUuid,
          type: fileType,
          isLast: isLastRecording,
          uri,
          batch,
          duration,
        },
      ]);
    });
  }

  /**
   * This will push the recording data to the stack of recordings. This way we can GUARANTEE that the recordings have the expected amount of data on each time we send.
   *
   * If we don't do this, we will need to await, needing to await we have NO control over the amount of data we are sending. Because it can take a lot of time to send the data
   * to the server. So we process the data and add it to a queue, then we sequentially send the data to the server even if the user stops recording.
   */
  function recursivelyGetRecordingDataAndStopRecordingBuilder({
    recording,
    progressUpdateInMilliseconds,
    batch,
    recordingUuid,
    appStateListener,
  }: {
    /** The recording instance received from the expo-av library after starting the recording. */
    recording: {
      current: Audio.Recording;
      hasEnded: boolean;
      duration: {
        batch: number;
        total: number;
      };
    };
    /** The amount of time in milliseconds to wait before checking the recording status. */
    progressUpdateInMilliseconds: number;
    /** Used inside the recursion, don't need to set explicitly, this holds the batch number */
    batch?: number;
    /** Used inside the recursion, don't need to set explicitly, this will be the uuid of the recording so we can have full context of all the recordings through the snippets */
    recordingUuid?: string;
    appStateListener?: ReturnType<typeof AppState.addEventListener>;
  }) {
    batch = batch || 0;
    recordingUuid = recordingUuid || uuid();
    if (appStateListener) appStateListener.remove();

    const currentRecording = recording.current;
    if (recordingTimeoutByRecordingUuid.get(recordingUuid))
      clearTimeoutCoordinator(
        recordingTimeoutByRecordingUuid.get(recordingUuid)
      );

    async function pushRecordingStateAndStartNewRecording() {
      const doesRecordingExists = currentRecording instanceof Audio.Recording;
      const hasRecordingStopped =
        recording.hasEnded &&
        doesRecordingExists &&
        currentRecording._isDoneRecording;
      const shouldStopRecording =
        doesRecordingExists === false || hasRecordingStopped;

      // logger.log(
      //   "pushRecordingStateAndStartNewRecording",
      //   "shouldStopRecording",
      //   shouldStopRecording,
      //   recording.hasEnded,
      //   doesRecordingExists,
      //   hasRecordingStopped
      // );
      if (shouldStopRecording) {
        const status = await currentRecording.getStatusAsync();
        const hasNotStoppedRecording =
          status.isRecording === true && status.isDoneRecording !== true;
        if (hasNotStoppedRecording) await currentRecording.stopAndUnloadAsync();
        const uri = currentRecording.getURI();

        const totalDurationInMillis =
          recording.hasEnded === true
            ? recording.duration.total
            : recording.duration.total + status.durationMillis;
        const batchDurationInMillis =
          recording.hasEnded === true
            ? recording.duration.batch
            : status.durationMillis;

        recordingTimeoutByRecordingUuid.delete(recordingUuid);
        pushDataToStack(recordingUuid, uri, batch, recording.hasEnded, {
          batch: batchDurationInMillis,
          total: totalDurationInMillis,
        });
        return;
      }
      const status = await currentRecording.getStatusAsync();

      // logger.log(
      //   emailAddress,
      //   status.durationMillis,
      //   SNIPPET_LENGTH_IN_MILLISECONDS,
      //   status.isDoneRecording,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "Recording duration is less than the snippet length. Shouldn't stop, but stopping"
      // );

      if (status.durationMillis <= SNIPPET_LENGTH_IN_MILLISECONDS) {
        logger.log(
          emailAddress,

          "recursivelyGetRecordingDataAndStopRecordingBuilder",
          "Recording duration is less than the snippet length. Not stopping"
        );
        return recursivelyGetRecordingDataAndStopRecordingBuilder({
          recording,
          progressUpdateInMilliseconds,
          batch: batch,
          recordingUuid,
          appStateListener,
        });
      }

      await currentRecording.stopAndUnloadAsync();
      const uri = currentRecording.getURI();

      const totalDurationInMillis =
        recording.hasEnded === true
          ? recording.duration.total
          : recording.duration.total + status.durationMillis;
      const batchDurationInMillis =
        recording.hasEnded === true
          ? recording.duration.batch
          : status.durationMillis;

      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "Recording timeout, ",
      //   "push data to stack"
      // );

      pushDataToStack(recordingUuid, uri, batch, recording.hasEnded, {
        batch: batchDurationInMillis,
        total: totalDurationInMillis,
      });

      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "Prepare a new recording "
      // );

      const newRecording = new Audio.Recording();
      await newRecording.prepareToRecordAsync(recordingOptions);

      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "Prepared, starting a new recording"
      // );
      await newRecording.startAsync();

      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "Created a new recording"
      // );

      audioRecording.current = newRecording;
      // If you just create a new object we will lose the reference to the current object so we will be unable to stop the recording.
      recording.current = newRecording;
      recording.duration.batch = 0;
      recording.duration.total = totalDurationInMillis;

      recursivelyGetRecordingDataAndStopRecordingBuilder({
        recording,
        progressUpdateInMilliseconds,
        batch: batch + 1,
        recordingUuid,
        appStateListener,
      });
    }

    appStateListener = AppState.addEventListener("change", (nextAppState) => {
      const isInForeground =
        appStateRef.current.recording.match(/inactive|background/) &&
        nextAppState === "active";

      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "AppState changed",
      //   appStateRef.current,
      //   nextAppState,
      //   isInForeground,
      //   recording
      // );
      if (recording.hasEnded === false) {
        if (isInForeground) {
          // logger.log(
          //   emailAddress,
          //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
          //   "is in foreground stop the recording right away"
          // );
          pushRecordingStateAndStartNewRecording();
        } else
          recursivelyGetRecordingDataAndStopRecordingBuilder({
            progressUpdateInMilliseconds,
            recording,
            batch,
            recordingUuid,
            appStateListener,
          });
      }
      appStateRef.current.recording = nextAppState;
    });

    recordingTimeoutByRecordingUuid.set(
      recordingUuid,
      setTimeoutCoordinator(
        async () => {
          // logger.log(
          //   emailAddress,
          //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
          //   "Recording timeout, stop recording and start a new one for next batch"
          // );
          if (
            appStateRef.current.recording !== "active" &&
            recording.hasEnded === false
          ) {
            // logger.log(
            //   emailAddress,
            //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
            //   'Prevent the recording from stopping because the app is not in the "active" state'
            // );
            recursivelyGetRecordingDataAndStopRecordingBuilder({
              recording,
              progressUpdateInMilliseconds,
              batch: batch,
              recordingUuid,
              appStateListener,
            });
            return;
          }
          await pushRecordingStateAndStartNewRecording();
        },
        progressUpdateInMilliseconds,
        appStateRef.current.recording === "active"
      )
    );

    return async () => {
      // logger.log(
      //   emailAddress,
      //   "recursivelyGetRecordingDataAndStopRecordingBuilder",
      //   "stoppping recording..."
      // );
      const recordingStatus = await recording.current.getStatusAsync();
      recording.duration.batch = recordingStatus.durationMillis;
      recording.duration.total =
        recording.duration.total + recording.duration.batch;

      if (recordingStatus.isDoneRecording !== true)
        await recording.current.stopAndUnloadAsync();

      recording.hasEnded = true;
      setIsRecording(false);
      setRecordingTime({
        startTime: 0,
        elapsedTime: 0,
      });

      audioRecording.current = undefined;
      await setAudioMode(true);
    };
  }

  /**
   * This will call the API sequentially sending the recording data to the server in batches. This way we can control the amount of data we are sending
   * to the server from each request. It doesn't matter if the user stops recording it will keep sending data to the server.
   *
   * This function is supposed to keep running forever, so it will call itself recursively.
   *
   * @param progressUpdateInMilliseconds - The amount of time in milliseconds to wait before sending the next batch of data to the server.
   */
  function recursivelySendRecordingDataSequentially(
    progressUpdateInMilliseconds: number,
    appStateListener?: ReturnType<typeof AppState.addEventListener>
  ) {
    // logger.log(
    //   emailAddress,
    //   "recursivelySendRecordingDataSequentially",
    //   appStateRef.current
    // );
    if (appStateListener) appStateListener.remove();
    if (sendUpdatesTimeout) clearTimeoutCoordinator(sendUpdatesTimeout);
    appStateListener = AppState.addEventListener("change", (nextAppState) => {
      // logger.log(
      //   emailAddress,
      //   "recursivelySendRecordingDataSequentially",
      //   "AppState changed",
      //   appStateRef.current
      // );
      recursivelySendRecordingDataSequentially(
        progressUpdateInMilliseconds,
        appStateListener
      );
      appStateRef.current.sending = nextAppState;
    });

    sendUpdatesTimeout = setTimeoutCoordinator(
      async () => {
        // logger.log(
        //   emailAddress,
        //   "recursivelySendRecordingDataSequentially",
        //   "Getting recording batches.."
        // );

        const networkState = await getNetworkStateAsync();
        if (
          (networkState.isConnected && networkState.isInternetReachable) ===
          false
        ) {
          // logger.log(
          //   emailAddress,
          //   "recursivelySendRecordingDataSequentially",
          //   "No internet connection, retrying.."
          // );
          return recursivelySendRecordingDataSequentially(
            progressUpdateInMilliseconds,
            appStateListener
          );
        }

        const recordingBatches = await retrieveRecordingBatches();
        if (recordingBatches.length === 0)
          return recursivelySendRecordingDataSequentially(
            progressUpdateInMilliseconds,
            appStateListener
          );

        const { uuid, type, uri, batch, duration, isLast } =
          recordingBatches.shift();

        const slackThreadsByRecordingUuid =
          await retrieveSlackThreadsByRecordingUuid();
        const threadId = slackThreadsByRecordingUuid[uuid];
        recordingBatchesRef.current = recordingBatches;

        // logger.log(
        //   emailAddress,
        //   "recursivelySendRecordingDataSequentially",
        //   "Sending data to the server..",
        //   {
        //     lengthOfBatches: recordingBatches.length,
        //     uri,
        //     uuid,
        //     type,
        //     batch,
        //     duration,
        //     threadId,
        //   }
        // );
        try {
          // logger.log(emailAddress, "Sending data to the server");
          const newThreadId = await Promise.resolve(
            callbackForSendingRecordingDataAsBase64({
              uri,
              isLast,
              threadId,
              recordingUuid: uuid,
              type,
              batch,
              duration: {
                batch: duration.batch,
                total: duration.total,
              },
            })
          );

          if (isLast !== true) {
            slackThreadsByRecordingUuidRef.current = {
              ...(slackThreadsByRecordingUuidRef?.current || {}),
              [uuid]: newThreadId,
            };
          } else {
            slackThreadsByRecordingUuidRef.current = {
              ...(slackThreadsByRecordingUuidRef?.current || {}),
              [uuid]: undefined,
            };
          }
        } catch (err) {
          console.log(err.code, err?.message?.toLowerCase());

          const [networkState, newRecordingBatches] = await Promise.all([
            getNetworkStateAsync(),
            retrieveRecordingBatches(),
          ]);

          if (
            networkState.isConnected === false ||
            networkState.isInternetReachable === false ||
            err?.message === `Cannot read property 'jwt' of null`
          ) {
            newRecordingBatches.unshift({
              uuid,
              type,
              uri,
              batch,
              duration,
              isLast,
            });

            recordingBatchesRef.current = newRecordingBatches;
          } else
            logger.error(
              "recursivelySendRecordingDataSequentially",
              "Failed to send data to the server",
              JSON.stringify(err, null, 2),
              err?.code,
              err?.message
            );
        }

        recursivelySendRecordingDataSequentially(
          progressUpdateInMilliseconds,
          appStateListener
        );
      },
      progressUpdateInMilliseconds,
      appStateRef.current.sending === "active"
    );
  }

  async function startRecording() {
    try {
      if (permissionResponse?.status !== "granted") {
        Linking.openSettings();
        return;
      }
      await setAudioMode();

      // logger.log(emailAddress, "Starting recording..");

      const { recording } = await Audio.Recording.createAsync(recordingOptions);
      audioRecording.current = recording;
      setIsRecording(true);

      stopRecordingCallback.current =
        recursivelyGetRecordingDataAndStopRecordingBuilder({
          recording: {
            current: recording,
            hasEnded: false,
            duration: { total: 0, batch: 0 },
          },
          progressUpdateInMilliseconds: SNIPPET_LENGTH_IN_MILLISECONDS,
        });
      // logger.log(emailAddress, "Recording started");
    } catch (err) {
      logger.error(emailAddress, "Failed to start recording", err);
    }
  }

  async function stopRecording() {
    // logger.log(
    //   "called to stop recording",
    //   typeof stopRecordingCallback.current === "function"
    // );
    if (stopRecordingCallback.current) await stopRecordingCallback.current();
    else {
      // logger.log('Lost the reference to the "stopRecordingCallback" function');
      await audioRecording.current.stopAndUnloadAsync();
      BackgroundTimer.clearTimeout();
      stopRecordingCallback.current =
        recursivelyGetRecordingDataAndStopRecordingBuilder({
          recording: {
            current: audioRecording.current,
            hasEnded: true,
            duration: { total: 0, batch: 0 },
          },
          progressUpdateInMilliseconds: SNIPPET_LENGTH_IN_MILLISECONDS,
        });
      if (stopRecordingCallback.current) await stopRecordingCallback.current();
    }
  }

  const existingRecording = {};
  async function startRecordingAfterDelay(delay: number) {
    existingRecording.current = new Audio.Recording()
    await existingRecording.current.prepareToRecordAsync(recordingOptions)
    await existingRecording.current.startAsync();
    console.log('start')
    BackgroundTimer.setTimeout(async () => {
      const status = await existingRecording.current.getStatusAsync();
      await existingRecording.current.stopAndUnloadAsync();
      const uri = existingRecording.current.getURI();
      console.log(uri, 'delay', status)
      console.log('end')
      startRecordingAfterDelay(60000);
      setTimeout(() => {
      }, 1000);
    }, delay);
  }

  async function stopRecordingAfterDelay() {
    BackgroundTimer.clearTimeout();
    await existingRecording.current.stopAndUnloadAsync();
    const uri = existingRecording.current.getURI();
    console.log(uri, 'stop delay')
  }

  useEffect(() => {
    askForPermission()
      .then(() => {
        logger.log("permitted");
      })
      .catch((e) => {
        logger.log(e);
      });
    const subscription = AppState.addEventListener(
      "change",
      async (nextAppState) => {
        const isInForeground =
          appStateRef.current.permissions.match(/inactive|background/) &&
          nextAppState === "active";

        if (isInForeground && permissionResponse?.status !== "granted")
          askForPermission();

        appStateRef.current.permissions = nextAppState;
        setAppState(nextAppState);
      }
    );

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    //dataFromOutsideScope.current = "Hello World!";
    recursivelySendRecordingDataSequentially(
      SNIPPET_LENGTH_IN_MILLISECONDS / 2
    );
    return () => {
      // logger.log(emailAddress, "cleanup");
      if (sendUpdatesTimeout) clearTimeoutCoordinator(sendUpdatesTimeout);
    };
  }, []);

  useEffect(() => {
    const startTime =
      recordingTime.startTime === 0 ? Date.now() : recordingTime.startTime;

    if (isRecording === true && withTimer === true && appState === "active") {
      const interval = setLayoutTimeout(() => {
        setRecordingTime(() => {
          const elapsedTime = Date.now() - startTime;
          return {
            startTime,
            elapsedTime,
          };
        });
      }, 1000);

      return () => {
        clearLayoutTimeout(interval);
      };
    }
  }, [isRecording, recordingTime, appState]);

  return {
    startRecordingAfterDelay,
    recordingTime,
    isRecording,
    startRecording,
    stopRecording,
    permissionStatus,
    askForPermission,
    stopRecordingAfterDelay
  };
}
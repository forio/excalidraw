// @ts-nocheck
import throttle from "lodash.throttle";
import { PureComponent } from "react";
import { ExcalidrawImperativeAPI } from "../../types";
import { APP_NAME, ENV, EVENT } from "../../constants";
import { ImportedDataState } from "../../data/types";
import { ExcalidrawElement } from "../../element/types";
import {
  getSceneVersion,
  restoreElements,
} from "../../packages/excalidraw/index";
import { Collaborator, Gesture } from "../../types";
import {
  preventUnload,
  resolvablePromise,
  withBatchedUpdates,
} from "../../utils";
import {
  CURSOR_SYNC_TIMEOUT,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  WS_SCENE_EVENT_TYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../app_constants";
import { getSyncableElements, SocketUpdateDataSource } from "../data";
import Portal from "./Portal";
import { t } from "../../i18n";
import { UserIdleState } from "../../types";
import { IDLE_THRESHOLD, ACTIVE_THRESHOLD } from "../../constants";
import { FileManager } from "../data/FileManager";
import { isImageElement } from "../../element/typeChecks";
import { newElementWith } from "../../element/mutateElement";
import {
  ReconciledElements,
  reconcileElements as _reconcileElements,
} from "./reconciliation";
import { decryptData } from "../../data/encryption";
import { resetBrowserStateVersions } from "../data/tabSync";
import { LocalData } from "../data/LocalData";
import { atom, useAtom } from "jotai";
import { appJotaiStore } from "../app-jotai";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const collabDialogShownAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string;
  username: string;
}

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: (username: string) => void;
}

interface PublicProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

type Props = PublicProps & { modalIsShown: boolean };

class Collab extends PureComponent<Props, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: Props["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<string, Collaborator>();

  constructor(props: Props) {
    super(props);
    this.state = {
      errorMessage: "",
      username: props.displayName,
    };
    this.portal = new Portal(this, props.compress);
    this.fileManager = new FileManager({
      getFiles: () => {},
      //   getFiles: async (fileIds) => {
      //     const loadedFiles = [];
      //     const erroredFiles = [];
      //     await Promise.all(
      //       [...new Set(fileIds)].map((fileId) =>
      //         fetch(fileId)
      //           .then((res) => res.blob())
      //           .then(async (blob) =>
      //             loadedFiles.push({
      //               id: fileId,
      //               dataURL: await getDataURL(blob),
      //             }),
      //           )
      //           .catch(() => erroredFiles.push(fileId)),
      //       ),
      //     );
      //     return { loadedFiles, erroredFiles };
      //   },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    const collabAPI: CollabAPI = {
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      //   fetchImageFilesFromFirebase: this.fetchUnloadedImages,
      stopCollaboration: this.stopCollaboration,
    };

    this.props.setCollabAPI(collabAPI);
    this.onOfflineStatusToggle();

    if (
      process.env.NODE_ENV === ENV.TEST ||
      process.env.NODE_ENV === ENV.DEVELOPMENT
    ) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
    this.startCollaboration();
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.queueBroadcastAllElements.cancel();
  }

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    // const syncableElements = getSyncableElements(
    //   this.getSceneElementsIncludingDeleted(),
    // );

    // if (
    //   this.fileManager.shouldPreventUnload(syncableElements) ||
    //   !isSavedToFirebase(this.portal, syncableElements)
    // ) {
    //   // this won't run in time if user decides to leave the site, but
    //   //  the purpose is to run in immediately after user decides to stay
    //   this.saveCollabRoomToFirebase(syncableElements);

    // }
    preventUnload(event);
  });

  //   saveCollabRoomToFirebase = async (
  //     syncableElements: readonly SyncableExcalidrawElement[],
  //   ) => {
  //     // TODO (?)
  //     // try {
  //     //   const savedData = await saveToFirebase(
  //     //     this.portal,
  //     //     syncableElements,
  //     //     this.excalidrawAPI.getAppState(),
  //     //   );

  //     //   if (savedData && savedData.reconciledElements) {
  //     //     this.handleRemoteSceneUpdate(
  //     //       this.reconcileElements(savedData.reconciledElements),
  //     //     );
  //     //   }
  //     // } catch (error: any) {
  //     //   this.setState({
  //     //     // firestore doesn't return a specific error code when size exceeded
  //     //     errorMessage: /is longer than.*?bytes/.test(error.message)
  //     //       ? t("errors.collabSaveFailed_sizeExceeded")
  //     //       : t("errors.collabSaveFailed"),
  //     //   });
  //     //   console.error(error);
  //     // }
  //   };

  stopCollaboration = (keepRemoteState = true) => {
    // TODO (?)
    return console.log("stopCollaboration");
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        commitToHistory: false,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    // TODO (?)
    return console.log("destroySocketClient");
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    if (!opts?.isUnload) {
      this.setState({
        activeRoomLink: "",
      });
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  //   private fetchUnloadedImages = async (opts: {
  //     elements: readonly ExcalidrawElement[];
  //     /**
  //      * Indicates whether to fetch files that are errored or pending and older
  //      * than 10 seconds.
  //      *
  //      * Use this as a machanism to fetch files which may be ok but for some
  //      * reason their status was not updated correctly.
  //      */
  //     forceFetchFiles?: boolean;
  //   }) => {
  //     const unfetchedImages = opts.elements
  //       .filter((element) => {
  //         return (
  //           isInitializedImageElement(element) &&
  //           !this.fileManager.isFileHandled(element.fileId) &&
  //           !element.isDeleted
  //         );
  //       })
  //       .map((element) => (element as InitializedExcalidrawImageElement).fileId);

  //     return await this.fileManager.getFiles(unfetchedImages);
  //   };

  private decryptPayload = async (
    iv: Uint8Array,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ) => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: "INVALID_RESPONSE",
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (): Promise<ImportedDataState | null> => {
    if (this.portal.socket) {
      return null;
    }

    const scenePromise = resolvablePromise<ImportedDataState | null>();

    try {
      LocalData.pauseSave("collaboration");
    } catch (error: any) {
      console.error(error);
    }

    const fallbackInitializationHandler = () => {
      // TODO (?)
      return console.log("fallbackInitializationHandler");
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(this.props.socket, this.props.room);

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setState({ errorMessage: error.message });
      return null;
    }

    // if (!existingRoomLinkData) {
    const elements = this.excalidrawAPI.getSceneElements().map((element) => {
      if (isImageElement(element) && element.status === "saved") {
        return newElementWith(element, { status: "pending" });
      }
      return element;
    });
    // remove deleted elements from elements array & history to ensure we don't
    // expose potentially sensitive user data in case user manually deletes
    // existing elements (or clears scene), which would otherwise be persisted
    // to database even if deleted before creating the room.
    this.excalidrawAPI.history.clear();
    this.excalidrawAPI.updateScene({
      elements,
      commitToHistory: true,
    });

    // this.saveCollabRoomToFirebase(getSyncableElements(elements));
    // }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on("client-broadcast", async (payload) => {
      const data = this.props.decompress(payload);

      switch (data.type) {
        case "INVALID_RESPONSE":
          return;
        case WS_SCENE_EVENT_TYPES.INIT: {
          if (!this.portal.socketInitialized) {
            this.initializeRoom({ fetchScene: false });
            const remoteElements = data.payload.elements;
            const reconciledElements = this.reconcileElements(remoteElements);
            this.handleRemoteSceneUpdate(reconciledElements, {
              init: true,
            });
            // noop if already resolved via init from firebase
            scenePromise.resolve({
              elements: reconciledElements,
              scrollToContent: true,
            });
          }
          break;
        }
        case WS_SCENE_EVENT_TYPES.UPDATE:
          this.handleRemoteSceneUpdate(
            this.reconcileElements(data.payload.elements),
          );
          break;
        case "MOUSE_LOCATION": {
          const { pointer, button, username, selectedElementIds } =
            data.payload;
          const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
            data.payload.socketId ||
            // @ts-ignore legacy, see #2094 (#2097)
            data.payload.socketID;

          const collaborators = new Map(this.collaborators);
          const user = collaborators.get(socketId) || {}!;
          user.pointer = pointer;
          user.button = button;
          user.selectedElementIds = selectedElementIds;
          user.username = username;
          collaborators.set(socketId, user);
          this.excalidrawAPI.updateScene({
            collaborators,
          });
          break;
        }
        case "IDLE_STATUS": {
          const { userState, socketId, username } = data.payload;
          const collaborators = new Map(this.collaborators);
          const user = collaborators.get(socketId) || {}!;
          user.userState = userState;
          user.username = username;
          this.excalidrawAPI.updateScene({
            collaborators,
          });
          break;
        }
      }
    });

    // TODO (?)
    // this.portal.socket.on("first-in-room", async () => {
    //   if (this.portal.socket) {
    //     this.portal.socket.off("first-in-room");
    //   }
    //   const sceneData = await this.initializeRoom({
    //     fetchScene: true,
    //     roomLinkData: existingRoomLinkData,
    //   });
    //   scenePromise.resolve(sceneData);
    // });

    this.initializeIdleDetector();

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    // if (fetchScene && roomLinkData && this.portal.socket) {
    //   this.excalidrawAPI.resetScene();

    //   try {
    //     const elements = await loadFromFirebase(
    //       roomLinkData.roomId,
    //       roomLinkData.roomKey,
    //       this.portal.socket,
    //     );
    //     if (elements) {
    //       this.setLastBroadcastedOrReceivedSceneVersion(
    //         getSceneVersion(elements),
    //       );

    //       return {
    //         elements,
    //         scrollToContent: true,
    //       };
    //     }
    //   } catch (error: any) {
    //     // log the error and move on. other peers will sync us the scene.
    //     console.error(error);
    //   } finally {
    //     this.portal.socketInitialized = true;
    //   }
    // } else {
    // }
    this.portal.socketInitialized = true;
    return null;
  };

  private reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledElements => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();

    remoteElements = restoreElements(remoteElements, null);

    const reconciledElements = _reconcileElements(
      localElements,
      remoteElements,
      appState,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  //   private loadImageFiles = throttle(async () => {
  //     const { loadedFiles, erroredFiles } = await this.fetchUnloadedImages({
  //       elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
  //     });

  //     this.excalidrawAPI.addFiles(loadedFiles);

  //     updateStaleImageStatuses({
  //       excalidrawAPI: this.excalidrawAPI,
  //       erroredFiles,
  //       elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
  //     });
  //   }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledElements,
    { init = false }: { init?: boolean } = {},
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      commitToHistory: !!init,
    });

    // We haven't yet implemented multiplayer undo functionality, so we clear the undo stack
    // when we receive any messages from another peer. This UX can be pretty rough -- if you
    // undo, a user makes a change, and then try to redo, your element(s) will be lost. However,
    // right now we think this is the right tradeoff.
    this.excalidrawAPI.history.clear();

    // this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    window.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: string[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      if (this.collaborators.has(socketId)) {
        collaborators.set(socketId, this.collaborators.get(socketId)!);
      } else {
        collaborators.set(socketId, {});
      }
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly ExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SCENE_EVENT_TYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly ExcalidrawElement[]) => {
    this.broadcastElements(elements);
    // this.queueSaveToFirebase();
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SCENE_EVENT_TYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  //   queueSaveToFirebase = throttle(
  //     () => {
  //       // TODO (?)
  //       return console.log("queueSaveToFirebase");
  //       if (this.portal.socketInitialized) {
  //         this.saveCollabRoomToFirebase(
  //           getSyncableElements(
  //             this.excalidrawAPI.getSceneElementsIncludingDeleted(),
  //           ),
  //         );
  //       }
  //     },
  //     SYNC_FULL_SCENE_INTERVAL_MS,
  //     { leading: false },
  //   );

  render() {
    return null;
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (
  process.env.NODE_ENV === ENV.TEST ||
  process.env.NODE_ENV === ENV.DEVELOPMENT
) {
  window.collab = window.collab || ({} as Window["collab"]);
}

const _Collab: React.FC<PublicProps> = (props) => {
  const [collabDialogShown] = useAtom(collabDialogShownAtom);
  return <Collab {...props} modalIsShown={collabDialogShown} />;
};

export default _Collab;

export type TCollabClass = Collab;

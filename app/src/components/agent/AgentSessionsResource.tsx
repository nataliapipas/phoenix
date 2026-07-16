import { isTextUIPart } from "ai";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import {
  ConnectionHandler,
  commitLocalUpdate,
  graphql,
  useLazyLoadQuery,
  useMutation,
  usePaginationFragment,
  useRelayEnvironment,
} from "react-relay";

import { isAgentSessionGoneError } from "@phoenix/agent/chat/sessionExpiry";
import type { AgentUIMessage } from "@phoenix/agent/chat/types";
import { Button, Flex, Text } from "@phoenix/components";
import { ChatSessionUsage } from "@phoenix/components/agent/ChatSessionUsage";
import { Loading } from "@phoenix/components/core";
import { useNotify, useNotifyError } from "@phoenix/contexts";
import { useAgentContext, useAgentStore } from "@phoenix/contexts/AgentContext";
import type { AgentPosition } from "@phoenix/store/agentStore";
import { getErrorMessagesFromRelayMutationError } from "@phoenix/utils/errorUtils";

import type { AgentSessionsResource_sessions$key } from "./__generated__/AgentSessionsResource_sessions.graphql";
import type { AgentSessionsResourceDeleteMutation } from "./__generated__/AgentSessionsResourceDeleteMutation.graphql";
import type { AgentSessionsResourceQuery } from "./__generated__/AgentSessionsResourceQuery.graphql";
import type { AgentSessionsResourceSessionQuery } from "./__generated__/AgentSessionsResourceSessionQuery.graphql";
import { AgentChatHeader } from "./AgentChatPanelView";
import {
  AGENT_SESSIONS_CONNECTION_KEY,
  SESSION_PAGE_SIZE,
} from "./agentSessionRelay";
import { ChatView } from "./Chat";
import type { AgentSessionListItem } from "./SessionListMenu";
import {
  EMPTY_SESSION_DISPLAY_NAME,
  getSessionDisplayName,
} from "./sessionTitleUtils";
import { useAgentChat } from "./useAgentChat";
import { useAgentChatPanelState } from "./useAgentChatPanelState";

const sessionsQuery = graphql`
  query AgentSessionsResourceQuery($first: Int!) {
    ...AgentSessionsResource_sessions @arguments(first: $first)
  }
`;

type AgentSessionsResourceProps = {
  position?: AgentPosition;
  isPositionChangeDisabled?: boolean;
};

export function AgentSessionsResource(props: AgentSessionsResourceProps) {
  const [fetchKey, setFetchKey] = useState(0);
  return (
    <ErrorBoundary
      onReset={() => setFetchKey((current) => current + 1)}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <Flex
          direction="column"
          alignItems="center"
          justifyContent="center"
          gap="size-100"
          height="100%"
        >
          <Text>
            {error instanceof Error
              ? error.message
              : "Session history could not be loaded."}
          </Text>
          <Button size="S" onPress={resetErrorBoundary}>
            Retry
          </Button>
        </Flex>
      )}
    >
      <Suspense fallback={<Loading />}>
        <AgentSessionsLoader {...props} fetchKey={fetchKey} />
      </Suspense>
    </ErrorBoundary>
  );
}

function AgentSessionsLoader({
  fetchKey,
  ...props
}: AgentSessionsResourceProps & { fetchKey: number }) {
  const query = useLazyLoadQuery<AgentSessionsResourceQuery>(
    sessionsQuery,
    { first: SESSION_PAGE_SIZE },
    { fetchKey, fetchPolicy: "store-and-network" }
  );
  return <AgentSessionsContent {...props} query={query} />;
}

/**
 * Prunes expired temporary sessions when the user returns to the tab (and on
 * mount). Timers are unreliable in throttled or frozen background tabs, so
 * expiry is evaluated on the events that fire exactly when the user comes
 * back; a send into an already-expired session is separately caught by the
 * chat route's 404.
 */
function useExpiredSessionPruning({
  onActiveSessionPruned,
}: {
  onActiveSessionPruned: (details: { draftInput: string }) => void;
}) {
  const store = useAgentStore();
  useEffect(() => {
    const prune = () => {
      const { prunedActiveSession } = store.getState().pruneExpiredSessions();
      if (prunedActiveSession) {
        onActiveSessionPruned(prunedActiveSession);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        prune();
      }
    };
    prune();
    window.addEventListener("focus", prune);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", prune);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [onActiveSessionPruned, store]);
}

function AgentSessionsContent({
  query,
  position,
  isPositionChangeDisabled = false,
}: AgentSessionsResourceProps & {
  query: AgentSessionsResource_sessions$key;
}) {
  const { data, loadNext, hasNext, isLoadingNext } = usePaginationFragment<
    AgentSessionsResourceQuery,
    AgentSessionsResource_sessions$key
  >(
    graphql`
      fragment AgentSessionsResource_sessions on Query
      @refetchable(queryName: "AgentSessionsResourcePaginationQuery")
      @argumentDefinitions(
        after: { type: "String", defaultValue: null }
        first: { type: "Int", defaultValue: 20 }
      ) {
        agentSessions(first: $first, after: $after)
          @connection(key: "AgentSessionsResource_agentSessions") {
          edges {
            node {
              id
              title
              createdAt
              updatedAt
            }
          }
        }
      }
    `,
    query
  );
  const store = useAgentStore();
  const relayEnvironment = useRelayEnvironment();
  const activeSessionId = useAgentContext((state) => state.activeSessionId);
  const sessions = useAgentContext((state) => state.sessions);
  const sessionMap = useAgentContext((state) => state.sessionMap);
  const chatStatusBySessionId = useAgentContext(
    (state) => state.chatStatusBySessionId
  );
  const setActiveSession = useAgentContext((state) => state.setActiveSession);
  const createLocalSession = useAgentContext((state) => state.createSession);
  const deleteLocalSession = useAgentContext((state) => state.deleteSession);
  const notify = useNotify();
  const notifyError = useNotifyError();
  const connectionId = ConnectionHandler.getConnectionID(
    "client:root",
    AGENT_SESSIONS_CONNECTION_KEY
  );

  const createSession = useCallback(() => {
    const state = store.getState();
    for (const sessionId of state.sessions) {
      const session = store.getState().sessionMap[sessionId];
      const status = store.getState().chatStatusBySessionId[sessionId];
      if (
        session?.id == null &&
        status !== "submitted" &&
        status !== "streaming"
      ) {
        store.getState().deleteSession(sessionId);
      }
    }
    return createLocalSession();
  }, [createLocalSession, store]);

  const runtimeSessionById = useMemo(
    () =>
      new Map(
        Object.values(sessionMap).flatMap((session) =>
          session.id ? ([[session.id, session]] as const) : []
        )
      ),
    [sessionMap]
  );
  const serverSessions = data.agentSessions.edges.map(({ node }) => {
    const runtimeSession = runtimeSessionById.get(node.id);
    const clientKey = runtimeSession?.clientKey ?? node.id;
    return {
      clientKey,
      id: node.id,
      title: runtimeSession?.title || node.title,
      isTemporary: runtimeSession?.isTemporary ?? false,
      messages: runtimeSession?.messages ?? [],
      createdAt: Date.parse(node.createdAt as string),
      isDeleteDisabled:
        chatStatusBySessionId[clientKey] === "submitted" ||
        chatStatusBySessionId[clientKey] === "streaming",
    } satisfies AgentSessionListItem;
  });
  const serverSessionClientKeys = new Set(
    serverSessions.map((session) => session.clientKey)
  );
  // Temporary sessions never appear in the server connection, so every live
  // local session must be surfaced from the runtime store or it would vanish
  // from the menu the moment another chat becomes active.
  const localSessions: AgentSessionListItem[] = [...sessions]
    .reverse()
    .flatMap((sessionId) => {
      const session = sessionMap[sessionId];
      if (!session || serverSessionClientKeys.has(session.clientKey)) {
        return [];
      }
      return [
        {
          clientKey: session.clientKey,
          id: session.id,
          title: session.title,
          isTemporary: session.isTemporary,
          messages: session.messages,
          createdAt: session.createdAt,
          isDeleteDisabled:
            chatStatusBySessionId[session.clientKey] === "submitted" ||
            chatStatusBySessionId[session.clientKey] === "streaming",
        },
      ];
    });
  const orderedSessions = [...localSessions, ...serverSessions];
  const orderedSessionsRef = useRef(orderedSessions);
  orderedSessionsRef.current = orderedSessions;

  useEffect(() => {
    if (activeSessionId !== null || store.getState().activeSessionId !== null) {
      return;
    }
    const mostRecentSession = orderedSessionsRef.current[0];
    if (mostRecentSession) {
      setActiveSession(mostRecentSession.clientKey);
    } else {
      createSession();
    }
  }, [activeSessionId, createSession, setActiveSession, store]);

  const [commitDelete] =
    useMutation<AgentSessionsResourceDeleteMutation>(graphql`
      mutation AgentSessionsResourceDeleteMutation(
        $id: ID!
        $connectionId: ID!
      ) {
        deleteAgentSession(input: { id: $id }) {
          deletedAgentSessionId @deleteEdge(connections: [$connectionId])
        }
      }
    `);

  const deleteSession = useCallback(
    (sessionId: string) => {
      const session = orderedSessionsRef.current.find(
        (candidate) => candidate.clientKey === sessionId
      );
      const nextSession = orderedSessionsRef.current.find(
        (candidate) => candidate.clientKey !== sessionId
      );
      const isDeletingActiveSession = activeSessionId === sessionId;
      let replacementSessionId: string | null = null;
      if (isDeletingActiveSession) {
        if (nextSession) {
          setActiveSession(nextSession.clientKey);
        } else if (session?.id) {
          replacementSessionId = createSession();
        }
      }
      if (!session?.id) {
        deleteLocalSession(sessionId);
        if (isDeletingActiveSession && !nextSession) {
          createSession();
        }
        return;
      }
      commitDelete({
        variables: { id: session.id, connectionId },
        optimisticResponse: {
          deleteAgentSession: {
            deletedAgentSessionId: session.id,
          },
        },
        onCompleted: () => {
          deleteLocalSession(sessionId);
        },
        onError: (error) => {
          if (isDeletingActiveSession) {
            if (replacementSessionId) {
              deleteLocalSession(replacementSessionId);
            }
            setActiveSession(sessionId);
          }
          const messages = getErrorMessagesFromRelayMutationError(error);
          notifyError({
            title: "Session could not be deleted",
            message: messages?.[0] ?? error.message,
          });
        },
      });
    },
    [
      activeSessionId,
      commitDelete,
      connectionId,
      createSession,
      deleteLocalSession,
      notifyError,
      setActiveSession,
    ]
  );

  const activeSession = orderedSessions.find(
    (session) => session.clientKey === activeSessionId
  );
  const activeRuntimeSession = activeSessionId
    ? sessionMap[activeSessionId]
    : undefined;
  const sessionDisplayName = activeSession
    ? getSessionDisplayName(activeSession)
    : activeRuntimeSession
      ? getSessionDisplayName(activeRuntimeSession)
      : EMPTY_SESSION_DISPLAY_NAME;
  const panelState = useAgentChatPanelState();
  const handleMissingSession = useCallback(
    (sessionId: string) => {
      const missingSession = orderedSessionsRef.current.find(
        (session) => session.clientKey === sessionId
      );
      const nextSession = orderedSessionsRef.current.find(
        (session) => session.clientKey !== sessionId
      );
      const missingSessionId = missingSession?.id;
      if (missingSessionId) {
        commitLocalUpdate(relayEnvironment, (relayStore) => {
          const connection = ConnectionHandler.getConnection(
            relayStore.getRoot(),
            AGENT_SESSIONS_CONNECTION_KEY
          );
          if (connection) {
            ConnectionHandler.deleteNode(connection, missingSessionId);
          }
        });
      }
      if (nextSession) {
        setActiveSession(nextSession.clientKey);
      } else {
        createSession();
      }
    },
    [createSession, relayEnvironment, setActiveSession]
  );

  const handleActiveSessionPruned = ({
    draftInput,
  }: {
    draftInput: string;
  }) => {
    const newSessionId = createLocalSession();
    if (draftInput) {
      store.getState().setDraftInput(newSessionId, draftInput);
    }
    notify({
      title: "Temporary chat expired",
      message: draftInput
        ? "That chat expired and was removed. Your unsent message was moved to a new chat."
        : "That chat expired and was removed. You're now in a new chat.",
    });
  };
  useExpiredSessionPruning({
    onActiveSessionPruned: handleActiveSessionPruned,
  });

  // Recovery for a send the server rejected because the session no longer
  // exists — expired between client checks, swept early, or deleted in
  // another tab. The failed message text is restored into a fresh chat's
  // composer rather than auto-sent: the new session has none of the prior
  // context, so the user should re-decide before sending.
  const handleSessionGone = ({
    sessionId,
    restoredInput,
  }: {
    sessionId: string;
    restoredInput: string;
  }) => {
    const goneSession = store.getState().sessionMap[sessionId];
    if (!goneSession) {
      return;
    }
    // A persistent session deleted elsewhere may still have a cached edge in
    // the sessions connection; drop it so the menu agrees with the server.
    const goneSessionServerId = goneSession.id;
    if (goneSessionServerId) {
      commitLocalUpdate(relayEnvironment, (relayStore) => {
        const connection = ConnectionHandler.getConnection(
          relayStore.getRoot(),
          AGENT_SESSIONS_CONNECTION_KEY
        );
        if (connection) {
          ConnectionHandler.deleteNode(connection, goneSessionServerId);
        }
      });
    }
    const wasTemporary = goneSession.isTemporary;
    deleteLocalSession(sessionId);
    const newSessionId = createLocalSession();
    if (restoredInput) {
      store.getState().setDraftInput(newSessionId, restoredInput);
    }
    notify({
      title: wasTemporary ? "Temporary chat expired" : "Chat no longer exists",
      message: restoredInput
        ? "That chat is no longer available. Your message was moved to a new chat."
        : "That chat is no longer available. You're now in a new chat.",
    });
  };

  return (
    <>
      <AgentChatHeader
        sessionDisplayName={sessionDisplayName}
        orderedSessions={orderedSessions}
        activeSessionId={activeSessionId}
        isActiveSessionTemporary={activeRuntimeSession?.isTemporary ?? false}
        position={position}
        isPositionChangeDisabled={isPositionChangeDisabled}
        onSelectSession={setActiveSession}
        onDeleteSession={deleteSession}
        onCreateSession={createSession}
        hasNextSessionPage={hasNext}
        isLoadingNextSessionPage={isLoadingNext}
        onLoadNextSessionPage={() => loadNext(SESSION_PAGE_SIZE)}
        onPositionChange={panelState.setPosition}
        onClose={panelState.closePanel}
      />
      {activeSessionId ? (
        activeRuntimeSession ? (
          <AgentChatController
            key={activeSessionId}
            sessionId={activeSessionId}
            initialMessages={activeRuntimeSession.messages}
            onSessionGone={handleSessionGone}
          />
        ) : (
          <Suspense fallback={<Loading />}>
            <AgentSessionTranscript
              key={activeSessionId}
              sessionId={activeSessionId}
              onMissing={handleMissingSession}
              onSessionGone={handleSessionGone}
            />
          </Suspense>
        )
      ) : (
        <Loading />
      )}
    </>
  );
}

function AgentSessionTranscript({
  sessionId,
  onMissing,
  onSessionGone,
}: {
  sessionId: string;
  onMissing: (sessionId: string) => void;
  onSessionGone: (params: { sessionId: string; restoredInput: string }) => void;
}) {
  const data = useLazyLoadQuery<AgentSessionsResourceSessionQuery>(
    graphql`
      query AgentSessionsResourceSessionQuery($id: ID!) {
        agentSession: node(id: $id) {
          __typename
          ... on AgentSession {
            id
            title
            createdAt
            messages
          }
        }
      }
    `,
    { id: sessionId },
    { fetchPolicy: "store-or-network" }
  );
  const store = useAgentStore();
  const defaultModelConfig = useAgentContext(
    (state) => state.defaultModelConfig
  );
  const agentSession =
    data.agentSession.__typename === "AgentSession" ? data.agentSession : null;
  const messages = useMemo(
    () =>
      Array.isArray(agentSession?.messages)
        ? (agentSession.messages as AgentUIMessage[])
        : [],
    [agentSession?.messages]
  );

  useEffect(() => {
    if (!agentSession) {
      onMissing(sessionId);
      return;
    }
    store.getState().cacheSession({
      clientKey: sessionId,
      id: agentSession.id,
      title: agentSession.title,
      // Only persistent sessions are reachable through the sessions
      // connection, so a server-loaded transcript is never temporary.
      isTemporary: false,
      expiresAt: null,
      messages,
      context: [],
      modelConfig: { ...defaultModelConfig },
      createdAt: Date.parse(agentSession.createdAt as string),
    });
  }, [agentSession, defaultModelConfig, messages, onMissing, sessionId, store]);

  if (!agentSession) {
    return <Loading />;
  }
  return (
    <AgentChatController
      sessionId={sessionId}
      initialMessages={messages}
      onSessionGone={onSessionGone}
    />
  );
}

function AgentChatController({
  sessionId,
  initialMessages,
  onSessionGone,
}: {
  sessionId: string;
  initialMessages: AgentUIMessage[];
  onSessionGone: (params: { sessionId: string; restoredInput: string }) => void;
}) {
  const { chatApiUrl, modelSelection, menuValue, handleModelChange } =
    useAgentChatPanelState();
  const {
    messages,
    sendMessage,
    stop,
    status,
    error,
    pendingElicitation,
    handleElicitationSubmit,
    handleElicitationCancel,
    retryMessage,
    rewindToMessage,
    forkFromMessage,
  } = useAgentChat({
    sessionId,
    chatApiUrl,
    modelSelection,
    initialMessages,
  });

  useEffect(() => {
    if (!isAgentSessionGoneError(error)) {
      return;
    }
    // The failed send is the last user message: the AI SDK appends it to the
    // transcript before the request goes out.
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const restoredInput = lastUserMessage
      ? lastUserMessage.parts
          .filter(isTextUIPart)
          .map((part) => part.text)
          .join("")
      : "";
    onSessionGone({ sessionId, restoredInput });
  }, [error, messages, onSessionGone, sessionId]);

  return (
    <ChatView
      key={sessionId}
      sessionId={sessionId}
      messages={messages}
      sendMessage={sendMessage}
      stop={stop}
      status={status}
      error={error}
      pendingElicitation={pendingElicitation}
      handleElicitationSubmit={handleElicitationSubmit}
      handleElicitationCancel={handleElicitationCancel}
      retryMessage={retryMessage}
      rewindToMessage={rewindToMessage}
      forkFromMessage={forkFromMessage}
      modelMenuValue={menuValue}
      onModelChange={handleModelChange}
      autoFocusInput
    >
      <ChatSessionUsage sessionId={sessionId} />
    </ChatView>
  );
}

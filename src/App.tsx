import { Delete } from "@mui/icons-material";
import {
  ButtonBase,
  Divider,
  IconButton,
  InputBase,
  ThemeProvider,
  Typography,
  createTheme,
  styled,
} from "@mui/material";
import { ipcRenderer } from "electron";
import React, { useState } from "react";
import { MaterialUISwitch } from "./components/muiswitch";

interface MessageInterface {
  message: string;
  externalId: string;
}

const lightTheme = createTheme({
  palette: {
    mode: "light",
  },
});

const darkTheme = createTheme({
  palette: {
    mode: "dark",
  },
});

const Container = styled("div")(({ theme }) => ({
  fontFamily: theme.typography.fontFamily,
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  backgroundColor: theme.palette.background.default,
}));

const Title = styled("h3")(({ theme }) => ({
  color: theme.palette.primary.main,
  textAlign: "center",
}));

const BaloonsContainer = styled("div")(({ theme }) => ({
  height: "100%",
  overflowY: "scroll",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
}));

const BaloonContainer = styled(ButtonBase)(({ theme }) => ({
  width: "100%",
}));

const Baloon = styled("div")(({ theme }) => ({
  width: "100%",
  minHeight: "30px",
  display: "flex",
  alignItems: "center",
  justifyContent: "start",
  paddingTop: theme.spacing(1),
  paddingBottom: theme.spacing(1),
  paddingLeft: theme.spacing(2),
  paddingRight: theme.spacing(2),
}));

const InputContainer = styled("div")(({ theme }) => ({
  minHeight: "60px",
}));

const Input = styled(InputBase)(({ theme }) => ({
  backgroundColor: theme.palette.background.paper,
  padding: theme.spacing(1),
  height: "100%",
}));

function MessageBaloon({
  message,
  onClick,
  editing = false,
  onUpdateFinished,
  onDelete,
}: {
  message: MessageInterface;
  onClick?: (e: any, message: MessageInterface) => void;
  editing?: boolean;
  onUpdateFinished: (message: MessageInterface) => void;
  onDelete: (message: MessageInterface) => void;
}) {
  return (
    /* @ts-expect-error */
    <BaloonContainer component="div" onClick={(e) => onClick(e, message)}>
      <Divider />
      <Baloon>
        {editing ? (
          <Input
            placeholder="Type your message here"
            fullWidth
            multiline
            defaultValue={message.message}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onUpdateFinished({
                  ...message,
                  message: e.currentTarget.value,
                });
              }
            }}
          />
        ) : (
          <Typography
            sx={{
              width: "100%",
            }}
            color="primary"
          >
            {message.message}
          </Typography>
        )}
        <IconButton
          onClick={(e) => {
            e.stopPropagation();
            onDelete(message);
          }}
        >
          <Delete />
        </IconButton>
      </Baloon>
    </BaloonContainer>
  );
}

function App() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const baloonsRef = React.useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<MessageInterface[]>([]);
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [selectedMessage, setSelectedMessage] =
    React.useState<MessageInterface | null>(null);

  const toggleTheme = () => {
    setTheme(theme === "light" ? "dark" : "light");
  };

  const sendMessage = (message: string) => {
    ipcRenderer.invoke("send-message", message);
  };

  const deleteMessage = async (message: MessageInterface) => {
    await ipcRenderer.invoke("delete-message", message.externalId);
  };

  const updateMessage = async (message: MessageInterface) => {
    await ipcRenderer.invoke(
      "update-message",
      message.externalId,
      message.message
    );
    setSelectedMessage(null);
  };

  const getMessages = async () => {
    const messages = await ipcRenderer.invoke("get-messages");
    setMessages(messages);
  };

  ipcRenderer.on("refresh-messages", () => {
    getMessages();
  });

  React.useEffect(() => {
    getMessages();
  }, []);

  React.useEffect(() => {
    baloonsRef.current?.scrollTo({
      top: baloonsRef.current?.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const onBaloonClick = (e: any, message: MessageInterface) => {
    setAnchorEl(e.currentTarget);
    setSelectedMessage(message);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  return (
    <ThemeProvider theme={theme === "light" ? lightTheme : darkTheme}>
      <Container>
        <Title>
          Local Network Chat
          <MaterialUISwitch checked={theme === "dark"} onChange={toggleTheme} />
        </Title>
        <BaloonsContainer ref={baloonsRef} id="baloons-container">
          {messages?.map(
            (
              message: {
                message: string;
                externalId: string;
              },
              index: number
            ) => (
              <MessageBaloon
                key={index}
                message={message}
                onClick={onBaloonClick}
                onUpdateFinished={updateMessage}
                editing={selectedMessage?.externalId === message.externalId}
                onDelete={deleteMessage}
              />
            )
          )}
        </BaloonsContainer>
        <InputContainer>
          <Input
            placeholder="Type your message here"
            fullWidth
            multiline
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendMessage(e.currentTarget.value);
                e.currentTarget.value = "";
              }
            }}
          />
        </InputContainer>
      </Container>
    </ThemeProvider>
  );
}

export default App;

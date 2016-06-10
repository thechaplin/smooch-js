import { store } from '../stores/app-store';
import { addMessage, replaceMessage, removeMessage, setConversation, resetUnreadCount as resetUnreadCountAction } from '../actions/conversation-actions';
import { updateUser } from '../actions/user-actions';
import { showNotification, showErrorNotification } from '../actions/app-state-actions';
import { unsetFayeSubscriptions } from '../actions/faye-actions';
import { core } from './core';
import { immediateUpdate } from './user-service';
import { subscribeConversation, subscribeUser } from '../utils/faye';
import { observable } from '../utils/events';
import { resizeImage, getBlobFromDataUrl, isFileTypeSupported } from '../utils/media';
import { getDeviceId } from '../utils/device';

export function handleFirstUserMessage(response) {
    const state = store.getState();
    if (state.appState.settingsEnabled && !state.user.email) {
        const appUserMessageCount = state.conversation.messages.filter((message) => message.role === 'appUser').length;

        if (appUserMessageCount === 1) {
            // should only be one message from the app user
            store.dispatch(showNotification(store.getState().ui.text.settingsNotificationText));
        }
    }

    return response;
}

export function sendChain(sendFn) {
    const promise = immediateUpdate(store.getState().user);

    if (store.getState().user.conversationStarted) {
        return promise
            .then(connectFayeConversation)
            .then(sendFn)
            .then(handleFirstUserMessage);
    }

    // if it's not started, send the message first to create the conversation,
    // then get it and connect faye
    return promise
        .then(sendFn)
        .then(handleFirstUserMessage)
        .then(connectFayeConversation);
}

export function sendMessage(text) {
    return sendChain(() => {
        const message = {
            role: 'appUser',
            text,
            _clientId: Math.random(),
            _clientSent: new Date(),
            deviceId: getDeviceId()
        };

        store.dispatch(addMessage(message));

        const user = store.getState().user;

        return core().conversations.sendMessage(user._id, message).then((response) => {
            if (!user.conversationStarted) {
                // use setConversation to set the conversation id in the store
                store.dispatch(setConversation(response.conversation));
                store.dispatch(updateUser({
                    conversationStarted: true
                }));
            } else {
                store.dispatch(replaceMessage({
                    _clientId: message._clientId
                }, response.message));
            }

            observable.trigger('message:sent', response.message);
            return response;
        });
    });
}


export function uploadImage(file) {
    if (!isFileTypeSupported(file.type)) {
        store.dispatch(showErrorNotification(store.getState().ui.text.invalidFileError));
        return Promise.reject('Invalid file type');
    }

    return resizeImage(file).then((dataUrl) => {
        return sendChain(() => {
            const message = {
                mediaUrl: dataUrl,
                mediaType: 'image/jpeg',
                role: 'appUser',
                status: 'sending',
                _clientId: Math.random(),
                _clientSent: new Date()
            };

            store.dispatch(addMessage(message));

            const user = store.getState().user;
            const blob = getBlobFromDataUrl(dataUrl);

            return core().conversations.uploadImage(user._id, blob, {
                role: 'appUser',
                deviceId: getDeviceId()
            }).then((response) => {
                if (!user.conversationStarted) {
                    // use setConversation to set the conversation id in the store
                    store.dispatch(setConversation(response.conversation));
                    store.dispatch(updateUser({
                        conversationStarted: true
                    }));
                } else {
                    store.dispatch(replaceMessage({
                        _clientId: message._clientId
                    }, response.message));
                }

                observable.trigger('message:sent', response.message);
                return response;
            }).catch(() => {
                store.dispatch(showErrorNotification(store.getState().ui.text.messageError));
                store.dispatch(removeMessage({
                    _clientId: message._clientId
                }));

            });
        });
    }).catch(() => {
        store.dispatch(showErrorNotification(store.getState().ui.text.invalidFileError));
    });
}

export function getConversation() {
    const user = store.getState().user;
    return core().conversations.get(user._id).then((response) => {
        store.dispatch(setConversation(response.conversation));
        return response;
    });
}

export function connectFayeConversation() {
    const {conversationSubscription} = store.getState().faye;

    if (!conversationSubscription) {
        return subscribeConversation();
    }

    return Promise.resolve();
}

export function connectFayeUser() {
    const {userSubscription} = store.getState().faye;

    if (!userSubscription) {
        return subscribeUser();
    }

    return Promise.resolve();
}

export function disconnectFaye() {
    const {conversationSubscription, userSubscription} = store.getState().faye;

    if (conversationSubscription) {
        conversationSubscription.cancel();
    }

    if (userSubscription) {
        userSubscription.cancel();
    }

    store.dispatch(unsetFayeSubscriptions());
}

export function resetUnreadCount() {
    const {user, conversation} = store.getState();
    if (conversation.unreadCount > 0) {
        store.dispatch(resetUnreadCountAction());
        return core().conversations.resetUnreadCount(user._id).then((response) => {
            return response;
        });
    }

    return Promise.resolve();
}

export function handleConversationUpdated() {
    const subscription = store.getState().faye.subscription;

    if (!subscription) {
        return getConversation()
            .then((response) => {
                return connectFayeConversation().then(() => {
                    return response;
                });
            });
    }

    return Promise.resolve();
}

export function postPostback(actionId) {
    const {user} = store.getState();
    return core().conversations.postPostback(user._id, actionId).catch(() => {
        store.dispatch(showErrorNotification(store.getState().ui.text.actionPostbackError));
    });
}

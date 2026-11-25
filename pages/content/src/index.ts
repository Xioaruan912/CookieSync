import { initStorageMessageHandler } from './storageHandler';
import { initPageWatcher, refreshAppliedSignature } from './watcher';

initStorageMessageHandler(refreshAppliedSignature);
initPageWatcher();

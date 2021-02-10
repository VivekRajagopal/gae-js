import { CollectionReference, Firestore } from "@google-cloud/firestore";
import firebaseJson from "../../firebase.json";

export interface RepositoryItem {
  id: string;
  name: string;
}

export const connectFirestore = (): Firestore => {
  return new Firestore({
    projectId: "firestore-tests",
    host: firebaseJson.emulators.firestore.host,
    port: firebaseJson.emulators.firestore.port,
    ssl: false,
    credentials: { client_email: "test@example.com", private_key: "{}" },
  });
};

export const deleteCollection = async (collection: CollectionReference): Promise<void> => {
  const docs = await collection.limit(100).get();
  const batch = collection.firestore.batch();
  docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();

  if (docs.size === 100) {
    await deleteCollection(collection);
  }
};

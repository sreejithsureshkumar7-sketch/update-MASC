const firebaseConfig = {
  apiKey: "AIzaSyBquQHabdQyG-rytLwx6vZLhv1ZWd2o2hU",
  authDomain: "college-attendance-syste-62e89.firebaseapp.com",
  projectId: "college-attendance-syste-62e89",
  storageBucket: "college-attendance-syste-62e89.firebasestorage.app",
  messagingSenderId: "246869170235",
  appId: "1:246869170235:web:b080aa757d2b0ba079e41e",
  measurementId: "G-VELRXP6J3R"
};


firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const storage = firebase.storage();

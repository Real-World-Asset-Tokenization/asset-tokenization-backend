import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  // Check unique wallets for each demo account
  const users = await mongoose.connection.db.collection('users').find({}).toArray();
  console.log("Current users in DB:");
  users.forEach(u => console.log(` - ${u.email} (${u.role}): ${u.walletAddress}`));

  // Ensure punsithdaniru (Asset Owner) is linked to 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
  await mongoose.connection.db.collection('users').updateOne(
    { email: 'punsithdaniru@gmail.com' },
    { $set: { walletAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' } }
  );

  // Ensure inv1 is linked to 0x70997970c51812dc3a010c7d01b50e0d17dc79c8
  await mongoose.connection.db.collection('users').updateOne(
    { email: 'inv1@gmail.com' },
    { $set: { walletAddress: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' } }
  );

  // Ensure inv2 is linked to 0x14dc79964da2c08b23698b3d3cc7ca32193d9955
  await mongoose.connection.db.collection('users').updateOne(
    { email: 'inv2@gmail.com' },
    { $set: { walletAddress: '0x14dc79964da2c08b23698b3d3cc7ca32193d9955' } }
  );

  const updatedUsers = await mongoose.connection.db.collection('users').find({}).toArray();
  console.log("\nAuthoritative Registered Wallets in DB:");
  updatedUsers.forEach(u => console.log(` ✔ ${u.email} (${u.role}) => ${u.walletAddress}`));

  await mongoose.disconnect();
}

main().catch(console.error);

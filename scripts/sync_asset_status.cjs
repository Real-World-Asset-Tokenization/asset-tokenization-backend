const mongoose = require('mongoose');

const uri = 'mongodb://dbuser4sgqdq:Punsith21@fc-cc22349c8725-000.global.mongocluster.cosmos.azure.com:10260/rwa_tokenization?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000';

async function run() {
  try {
    await mongoose.connect(uri);
    const col = mongoose.connection.collection('assets');

    // Update Asset 1 to Tokenized and approved
    await col.updateOne(
      { assetId: 1 },
      { $set: { status: 'Tokenized', verificationStatus: 'approved', tokenizedAt: new Date() } }
    );

    // Update Asset 2 to Tokenized and approved
    await col.updateOne(
      { assetId: 2 },
      { $set: { status: 'Tokenized', verificationStatus: 'approved', tokenizedAt: new Date() } }
    );

    // Update Asset 3 to Tokenized and approved
    await col.updateOne(
      { assetId: 3 },
      { $set: { status: 'Tokenized', verificationStatus: 'approved', tokenizedAt: new Date() } }
    );

    // Update Asset 4 to Tokenized and approved
    await col.updateOne(
      { assetId: 4 },
      { $set: { status: 'Tokenized', verificationStatus: 'approved', tokenizedAt: new Date() } }
    );

    console.log('MongoDB assets updated successfully!');
    const docs = await col.find({}).toArray();
    docs.forEach(d => console.log('Asset', d.assetId, ':', d.name || d.assetName, '| Verification:', d.verificationStatus, '| Status:', d.status));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

run();

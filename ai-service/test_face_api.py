import requests
import os

# API endpoint
url = 'http://localhost:5001/face-verify'

# Image paths
id_path = 'uploads/ID.jpg'
selfie_path = 'uploads/selfie.jpg'

print("Testing face similarity via API...")
print(f"ID Image: {id_path}")
print(f"Selfie Image: {selfie_path}")
print()

# Check if files exist
if not os.path.exists(id_path):
    print(f"Error: ID image not found at {id_path}")
    exit(1)

if not os.path.exists(selfie_path):
    print(f"Error: Selfie image not found at {selfie_path}")
    exit(1)

try:
    # Prepare files for upload
    with open(id_path, 'rb') as id_file, open(selfie_path, 'rb') as selfie_file:
        files = {
            'document': ('ID.jpg', id_file, 'image/jpeg'),
            'selfie': ('selfie.jpg', selfie_file, 'image/jpeg')
        }
        
        print("Sending request to API...")
        response = requests.post(url, files=files)
        
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print("\n" + "=" * 50)
            print("FACE SIMILARITY RESULTS")
            print("=" * 50)
            
            if result.get('success'):
                data = result.get('data', {})
                print(f"Match: {data.get('match', False)}")
                print(f"Similarity Score: {data.get('similarityScore', 0)}%")
                print(f"Distance: {data.get('distance', 0)}")
                print(f"Confidence: {data.get('confidence', 'unknown')}")
                print("=" * 50)
                
                if data.get('match'):
                    print("✓ The selfie matches the ID photo")
                else:
                    print("✗ The selfie does not match the ID photo")
            else:
                print(f"Error: {result.get('error', 'Unknown error')}")
        else:
            print(f"Error: {response.text}")
            
except Exception as e:
    print(f"Error during API call: {e}")

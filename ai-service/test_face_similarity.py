from deepface import DeepFace
import os

# Image paths
id_path = 'uploads/ID.jpg'
selfie_path = 'uploads/selfie.jpg'

print("Testing face similarity between ID and selfie...")
print(f"ID Image: {id_path}")
print(f"Selfie Image: {selfie_path}")
print()

try:
    # Perform face verification using lighter model
    verification = DeepFace.verify(
        img1_path=id_path,
        img2_path=selfie_path,
        model_name='Facenet',
        detector_backend='opencv',
        enforce_detection=False
    )
    
    # Extract results
    similarity_score = verification.get('distance', 0)
    similarity_percentage = max(0, min(100, (1 - similarity_score) * 100))
    match = verification.get('verified', False)
    
    # Determine confidence level
    if similarity_percentage >= 80:
        confidence = 'high'
    elif similarity_percentage >= 60:
        confidence = 'medium'
    else:
        confidence = 'low'
    
    # Display results
    print("=" * 50)
    print("FACE SIMILARITY RESULTS")
    print("=" * 50)
    print(f"Match: {match}")
    print(f"Similarity Score: {similarity_percentage:.2f}%")
    print(f"Distance: {similarity_score:.4f}")
    print(f"Confidence Level: {confidence}")
    print("=" * 50)
    
    if match:
        print("✓ The selfie matches the ID photo")
    else:
        print("✗ The selfie does not match the ID photo")
        
except Exception as e:
    print(f"Error during face verification: {e}")
    print("Make sure DeepFace is installed: pip install deepface")
